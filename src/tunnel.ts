import { execFile, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AppConfig, TunnelConfig } from "./config.js";
import { configFilePath } from "./config.js";
import { logError, logInfo, logWarn } from "./log.js";

/** 日志尾部最多保留的行数与读取字节数 */
const TAIL_LINES = 8;
const TAIL_BYTES = 4096;
/** 外部进程 taskkill 后等待退出的时长 */
const STOP_WAIT_MS = 5000;

export interface TunnelManagerOptions {
  cloudflaredPath: string;
  configPath: string;
  /** cloudflared --logfile 写入的日志路径，退出后从这里取错误尾行 */
  logfilePath: string;
  /** 异常退出后自动重启（守护），默认 true */
  autoRestart: boolean;
  /** 异常退出到自动重启的延迟，默认 10 秒 */
  restartDelayMs?: number;
  /** 在 cloudflared 参数最前面追加的参数（stub 注入用） */
  argsPrefix?: string[];
  /** 外部（非本面板拉起）cloudflared 的存活检测，默认 tasklist 查询；测试可注入 */
  isRunningExternal?: () => Promise<boolean>;
}

export interface TunnelProcessInfo {
  running: boolean;
  /** true = 本面板拉起并持有句柄；false = 外部进程（如启动文件夹拉起），只读监控 */
  managed: boolean;
  pid?: number;
  /** 最后一次 managed 退出的退出码 */
  exitCode?: number;
  lastExitAt?: string;
  /** 正在等待自动重启 */
  autoRestarting?: boolean;
  /** cloudflared 日志最后几行，排障用 */
  tail?: string[];
  cloudflaredPath: string;
  configPath: string;
  exeMissing?: boolean;
  configMissing?: boolean;
}

function execFileText(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { windowsHide: true }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(stdout);
    });
  });
}

/** 用 tasklist 查是否有外部 cloudflared 在跑（与本机 nexus-tunnel.cmd 的判法一致） */
async function cloudflaredRunningExternal(): Promise<boolean> {
  try {
    const stdout = await execFileText("tasklist", [
      "/FI",
      "IMAGENAME eq cloudflared.exe",
      "/FO",
      "CSV",
      "/NH",
    ]);
    return stdout.toLowerCase().includes("cloudflared.exe");
  } catch {
    return false;
  }
}

function readTail(logfilePath: string): string[] {
  try {
    if (!existsSync(logfilePath)) return [];
    const size = statSync(logfilePath).size;
    if (size === 0) return [];
    const start = Math.max(0, size - TAIL_BYTES);
    const handle = openSync(logfilePath, "r");
    try {
      const buffer = Buffer.alloc(size - start);
      readSync(handle, buffer, 0, buffer.length, start);
      return buffer
        .toString("utf8")
        .split(/\r?\n/)
        .filter((line) => line.trim() !== "")
        .slice(-TAIL_LINES);
    } finally {
      closeSync(handle);
    }
  } catch {
    return [];
  }
}

function isAlive(child: ChildProcess | undefined): child is ChildProcess & { pid: number } {
  return !!child && child.exitCode === null && child.signalCode === null && typeof child.pid === "number";
}

function defaultCloudflaredPath(): string {
  const programFilesX86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
  return path.join(programFilesX86, "cloudflared", "cloudflared.exe");
}

function defaultTunnelConfigPath(): string {
  return path.join(os.homedir(), ".cloudflared", "config.yml");
}

/**
 * cloudflared 隧道进程管理：面板启停按钮、退出码与错误尾行、异常退出自动重启。
 * 进程以 detached + 无窗口拉起，服务退出不带走隧道；服务重启后按外部进程接管监控。
 */
export class TunnelManager {
  private child?: ChildProcess;
  private stopping = false;
  private restarting = false;
  private restartTimer?: NodeJS.Timeout;
  private lastExitCode?: number;
  private lastExitAt?: string;

  constructor(private options: TunnelManagerOptions) {}

  /** 取消挂起的自动重启定时器与状态位（不触碰正在运行的隧道进程） */
  cancelPendingRestart(): void {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = undefined;
    }
    this.restarting = false;
  }

  /** 仅停止本面板实例自己拉起的受管子进程（绝不误杀外部已运行的 cloudflared） */
  async stopManaged(): Promise<void> {
    this.cancelPendingRestart();
    if (!isAlive(this.child)) {
      this.child = undefined;
      return;
    }
    this.stopping = true;
    const child = this.child;
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
    this.child = undefined;
    logInfo("tunnel.stop", { reason: "config_change" });
  }

  /** 重载配置时同步隧道参数：若启动参数变了且受管子进程在跑，重启切换到新参数 */
  async syncOptions(options: TunnelManagerOptions): Promise<void> {
    const launchChanged =
      this.options.cloudflaredPath !== options.cloudflaredPath ||
      this.options.configPath !== options.configPath ||
      this.options.logfilePath !== options.logfilePath;
    const wasRunningManaged = isAlive(this.child);
    this.options = options;
    if (!options.autoRestart) {
      this.cancelPendingRestart();
    }
    if (launchChanged && wasRunningManaged) {
      await this.stopManaged();
      if (existsSync(options.cloudflaredPath) && existsSync(options.configPath)) {
        await this.start();
      }
    }
  }

  async status(): Promise<TunnelProcessInfo> {
    const alive = isAlive(this.child);
    let running = alive;
    let managed = alive;
    let pid = alive ? this.child!.pid : undefined;
    if (!alive && (await this.isExternalRunning())) {
      running = true;
      managed = false;
    }
    return {
      running,
      managed,
      pid,
      exitCode: this.lastExitCode,
      lastExitAt: this.lastExitAt,
      autoRestarting: this.restarting,
      tail: readTail(this.options.logfilePath),
      cloudflaredPath: this.options.cloudflaredPath,
      configPath: this.options.configPath,
      exeMissing: !existsSync(this.options.cloudflaredPath),
      configMissing: !existsSync(this.options.configPath),
    };
  }

  /** 返回 started=false 时 reason 说明为什么没拉起（已在运行等），不抛错 */
  async start(): Promise<{ started: boolean; reason?: string; pid?: number }> {
    // 无论后续早退或抛错，先清掉挂起的自动重启计划与状态位，避免 autoRestarting 卡死为 true
    this.cancelPendingRestart();

    if (!existsSync(this.options.cloudflaredPath)) {
      throw new Error(`找不到 cloudflared: ${this.options.cloudflaredPath}`);
    }
    if (!existsSync(this.options.configPath)) {
      throw new Error(`找不到隧道配置: ${this.options.configPath}`);
    }
    if (isAlive(this.child)) {
      return { started: false, reason: "已在运行（本面板拉起）", pid: this.child!.pid };
    }
    if (await this.isExternalRunning()) {
      return { started: false, reason: "已在运行（外部进程，可能是启动文件夹拉起）" };
    }

    this.stopping = false;

    const args = [
      ...(this.options.argsPrefix ?? []),
      "--config",
      this.options.configPath,
      "--logfile",
      this.options.logfilePath,
      "tunnel",
      "run",
    ];
    const child = spawn(this.options.cloudflaredPath, args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.on("error", (error: Error) => {
      logError("tunnel.error", { err: error.message });
    });
    child.once("exit", (code, signal) => this.handleExit(code, signal));
    // detached + unref：服务进程退出不带走隧道
    child.unref();
    this.child = child;
    logInfo("tunnel.start", { pid: child.pid });
    return { started: true, pid: child.pid };
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.cancelPendingRestart();
    if (isAlive(this.child)) {
      this.child.kill();
      await new Promise<void>((resolve) => {
        const child = this.child!;
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
    } else if (await this.isExternalRunning()) {
      // 外部进程没有句柄，按镜像名结束（与本机 nexus-tunnel.cmd 相同做法）
      await execFileText("taskkill", ["/IM", "cloudflared.exe", "/F"]).catch(() => undefined);
    }
    this.child = undefined;
    logInfo("tunnel.stop");
  }

  private handleExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.lastExitCode = code ?? undefined;
    this.lastExitAt = new Date().toISOString();
    if (this.stopping) {
      logInfo("tunnel.exit", { code: code ?? "-", signal: signal ?? "-" });
      return;
    }

    const delay = this.options.restartDelayMs ?? 10_000;
    logWarn("tunnel.exit", {
      code: code ?? "-",
      signal: signal ?? "-",
      auto_restart: this.options.autoRestart,
      delay_s: this.options.autoRestart ? Math.round(delay / 1000) : undefined,
    });
    if (!this.options.autoRestart) return;

    this.restarting = true;
    const timer = setTimeout(() => {
      this.restartTimer = undefined;
      this.restarting = false;
      void this.start()
        .then((result) => {
          if (!result.started) logWarn("tunnel.restart_skipped", { reason: result.reason ?? "" });
        })
        .catch((error: Error) => logError("tunnel.restart_failed", { err: error.message }));
    }, delay);
    timer.unref?.();
    this.restartTimer = timer;
  }

  private isExternalRunning(): Promise<boolean> {
    if (this.options.isRunningExternal) return this.options.isRunningExternal();
    // 测试缝（对齐 NEXUS_GIT_BASH 先例）：跑测试的机器可能有真隧道在运行，关掉外部检测保证用例自洽
    if (process.env.NEXUS_TUNNEL_EXTERNAL === "off") return Promise.resolve(false);
    return cloudflaredRunningExternal();
  }
}

/** 从 AppConfig 提取 TunnelManagerOptions；没有 tunnel 段时返回 undefined */
export function resolveTunnelOptions(config: AppConfig): TunnelManagerOptions | undefined {
  const tunnel: TunnelConfig | undefined = config.tunnel;
  if (!tunnel) return undefined;
  // 测试缝（对齐 NEXUS_GIT_BASH 的先例）：stub 脚本路径插在 cloudflared 参数最前面
  const stub = process.env.NEXUS_TUNNEL_STUB?.trim();
  return {
    cloudflaredPath: tunnel.cloudflaredPath ?? defaultCloudflaredPath(),
    configPath: tunnel.configPath ?? defaultTunnelConfigPath(),
    logfilePath: path.join(path.dirname(configFilePath()), "tunnel.log"),
    autoRestart: tunnel.autoRestart ?? true,
    ...(stub ? { argsPrefix: [stub] } : {}),
  };
}

/** 从 AppConfig 解析隧道管理器；config.json 没有 tunnel 段时返回 undefined（不启用启停按钮） */
export function resolveTunnelManager(config: AppConfig): TunnelManager | undefined {
  const options = resolveTunnelOptions(config);
  return options ? new TunnelManager(options) : undefined;
}
