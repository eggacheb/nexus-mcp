import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AppConfig } from "./config.js";
import { logError, logInfo, logWarn } from "./log.js";

/** 固定版本的官方 cloudflared Windows amd64 发布物与 SHA-256（来自 cloudflare/cloudflared 2026.11.2） */
export const CLOUDFLARED_VERSION = "2026.11.2";
export const CLOUDFLARED_DOWNLOAD_URL =
  "https://github.com/cloudflare/cloudflared/releases/download/2026.11.2/cloudflared-windows-amd64.exe";
export const CLOUDFLARED_SHA256 =
  "555b46c85582461d189cac30d14ad05480d612613801be9f110b8ce08c5b2113";

const TRY_CLOUDFLARE_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;
const STARTUP_TIMEOUT_MS = 20_000;
const STOP_WAIT_MS = 5_000;
const MAX_TAIL_LINES = 8;

export interface QuickTunnelInfo {
  running: boolean;
  downloading: boolean;
  pid?: number;
  url?: string;
  error?: string;
  tail?: string[];
  binaryPath?: string;
}

function isAlive(child: ChildProcess | undefined): child is ChildProcess & { pid: number } {
  return !!child && child.exitCode === null && child.signalCode === null && typeof child.pid === "number";
}

function defaultCacheDir(): string {
  const override = process.env.NEXUS_CLOUDFLARED_CACHE_DIR?.trim();
  if (override) return path.resolve(override);
  const localAppData = process.env.LOCALAPPDATA?.trim();
  if (localAppData) return path.join(localAppData, "nexus-mcp", "bin");
  return path.join(os.homedir(), ".nexus-mcp", "bin");
}

function cachedBinaryPath(): string {
  return path.join(defaultCacheDir(), "cloudflared.exe");
}

function systemCloudflaredCandidates(): string[] {
  if (process.env.NEXUS_CLOUDFLARED_SKIP_SYSTEM === "1") return [];
  const candidates: string[] = [];
  const pf86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
  const pf = process.env.ProgramFiles ?? "C:\\Program Files";
  candidates.push(path.join(pf86, "cloudflared", "cloudflared.exe"));
  candidates.push(path.join(pf, "cloudflared", "cloudflared.exe"));
  const pathEnv = process.env.PATH ?? "";
  for (const dir of pathEnv.split(path.delimiter)) {
    const trimmed = dir.trim();
    if (!trimmed) continue;
    candidates.push(path.join(trimmed, "cloudflared.exe"));
  }
  return candidates;
}

/** 按顺序定位已有的 cloudflared.exe：测试覆盖 → 配置显式路径 → 系统安装/PATH → 用户缓存 */
export function resolveCloudflaredBinary(config: AppConfig): string | undefined {
  const envExe = process.env.NEXUS_QUICK_TUNNEL_EXE?.trim();
  if (envExe && existsSync(envExe)) return path.resolve(envExe);

  const configured = config.tunnel?.cloudflaredPath?.trim();
  if (configured && existsSync(configured)) return path.resolve(configured);

  for (const candidate of systemCloudflaredCandidates()) {
    if (existsSync(candidate)) return candidate;
  }

  const cached = cachedBinaryPath();
  if (existsSync(cached)) return cached;

  return undefined;
}

/** 按需下载固定版本 cloudflared.exe 并校验 SHA-256，校验失败不落盘脏文件 */
export async function downloadCloudflared(): Promise<string> {
  const url = process.env.NEXUS_CLOUDFLARED_DOWNLOAD_URL?.trim() || CLOUDFLARED_DOWNLOAD_URL;
  const expectedSha = (process.env.NEXUS_CLOUDFLARED_SHA256?.trim() || CLOUDFLARED_SHA256).toLowerCase();
  const target = cachedBinaryPath();
  const dir = path.dirname(target);

  logInfo("quick_tunnel.download_start", { version: CLOUDFLARED_VERSION, target });
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) {
    throw new Error(`下载 cloudflared 失败：HTTP ${response.status}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  const actualSha = createHash("sha256").update(buffer).digest("hex").toLowerCase();
  if (actualSha !== expectedSha) {
    throw new Error(
      `cloudflared 校验和不符（期望 ${expectedSha.slice(0, 12)}…，实际 ${actualSha.slice(0, 12)}…），已拒绝落盘`,
    );
  }

  mkdirSync(dir, { recursive: true });
  const tempPath = `${target}.tmp.${process.pid}.${Date.now()}`;
  try {
    writeFileSync(tempPath, buffer);
    renameSync(tempPath, target);
  } catch (error) {
    rmSync(tempPath, { force: true });
    throw error;
  }
  logInfo("quick_tunnel.download_ok", { bytes: buffer.length, target });
  return target;
}

/**
 * 临时隧道（Cloudflare Quick Tunnel）管理器：
 * 零账号、零域名按需拉起 `cloudflared tunnel --url http://127.0.0.1:<port>`，
 * 解析并持有当前临时 `https://*.trycloudflare.com` 地址。
 */
export class QuickTunnelManager {
  private child?: ChildProcess;
  private publicUrl?: string;
  private downloading = false;
  private lastError?: string;
  private binaryPath?: string;
  private tail: string[] = [];

  currentUrl(): string | undefined {
    return isAlive(this.child) ? this.publicUrl : undefined;
  }

  isRunning(): boolean {
    return isAlive(this.child);
  }

  status(): QuickTunnelInfo {
    const alive = isAlive(this.child);
    return {
      running: alive,
      downloading: this.downloading,
      pid: alive ? this.child!.pid : undefined,
      url: alive ? this.publicUrl : undefined,
      error: this.lastError,
      tail: this.tail.slice(-MAX_TAIL_LINES),
      binaryPath: this.binaryPath,
    };
  }

  private pushTail(chunk: string): void {
    for (const rawLine of chunk.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) continue;
      this.tail.push(line);
      if (this.tail.length > MAX_TAIL_LINES * 2) {
        this.tail = this.tail.slice(-MAX_TAIL_LINES);
      }
    }
  }

  async start(localPort: number, config: AppConfig): Promise<QuickTunnelInfo> {
    if (isAlive(this.child) && this.publicUrl) {
      return this.status();
    }
    await this.stop();
    this.lastError = undefined;
    this.tail = [];

    let bin = resolveCloudflaredBinary(config);
    if (!bin) {
      this.downloading = true;
      try {
        bin = await downloadCloudflared();
      } catch (error) {
        this.lastError = (error as Error).message;
        throw error;
      } finally {
        this.downloading = false;
      }
    }
    this.binaryPath = bin;

    const stub = process.env.NEXUS_QUICK_TUNNEL_STUB?.trim();
    const spawnCmd = stub ? process.execPath : bin;
    const spawnArgs = [
      ...(stub ? [stub] : []),
      "tunnel",
      "--url",
      `http://127.0.0.1:${localPort}`,
      "--no-autoupdate",
    ];

    const child = spawn(spawnCmd, spawnArgs, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env: {
        ...process.env,
        ...(stub ? { NEXUS_RESOLVED_CLOUDFLARED: bin } : {}),
      },
    });
    this.child = child;
    this.publicUrl = undefined;

    try {
      const capturedUrl = await new Promise<string>((resolve, reject) => {
        let settled = false;
        const finish = (fn: () => void) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          fn();
        };

        const onChunk = (buf: Buffer) => {
          const text = buf.toString("utf8");
          this.pushTail(text);
          const match = text.match(TRY_CLOUDFLARE_RE);
          if (match) {
            this.publicUrl = match[0];
            finish(() => resolve(match[0]));
          }
        };

        child.stdout?.on("data", onChunk);
        child.stderr?.on("data", onChunk);
        child.once("error", (err: Error) => {
          this.lastError = err.message;
          logError("quick_tunnel.error", { err: err.message });
          finish(() => reject(err));
        });
        child.once("exit", (code, signal) => {
          logWarn("quick_tunnel.exit", { code: code ?? "-", signal: signal ?? "-" });
          if (this.child === child) {
            this.child = undefined;
            this.publicUrl = undefined;
          }
          if (!settled) {
            const detail = this.tail.slice(-2).join(" | ");
            const msg = `临时隧道启动后提前退出（code=${code ?? "-"}）${detail ? `：${detail}` : ""}`;
            this.lastError = msg;
            finish(() => reject(new Error(msg)));
          }
        });

        const timer = setTimeout(() => {
          const msg = `临时隧道在 ${Math.round(STARTUP_TIMEOUT_MS / 1000)} 秒内未分配到 trycloudflare.com 地址`;
          this.lastError = msg;
          finish(() => reject(new Error(msg)));
        }, STARTUP_TIMEOUT_MS);
        timer.unref?.();
      });

      logInfo("quick_tunnel.ready", { pid: child.pid, url: capturedUrl });
      return this.status();
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  async stop(): Promise<void> {
    const child = this.child;
    this.child = undefined;
    this.publicUrl = undefined;
    if (!isAlive(child)) return;

    child.kill();
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve();
        return;
      }
      const timer = setTimeout(resolve, STOP_WAIT_MS);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    logInfo("quick_tunnel.stop");
  }
}
