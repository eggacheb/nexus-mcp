import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { logInfo, logWarn } from "./log.js";

const APPROVAL_URL_RE = /https:\/\/login\.tailscale\.com\/[^\s"'<>]+/i;

export interface TailscaleInfo {
  installed: boolean;
  loggedIn: boolean;
  funnelActive: boolean;
  dnsName?: string;
  url?: string;
  approvalUrl?: string;
  error?: string;
  binaryPath?: string;
}

interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

function resolveTailscaleInvocation(): { cmd: string; prefix: string[]; binaryPath?: string } | undefined {
  const stub = process.env.NEXUS_TAILSCALE_STUB?.trim();
  if (stub) {
    return { cmd: process.execPath, prefix: [stub], binaryPath: stub };
  }
  const envBin = process.env.NEXUS_TAILSCALE_BIN?.trim();
  if (envBin === "missing") return undefined;
  if (envBin && existsSync(envBin)) {
    return { cmd: envBin, prefix: [], binaryPath: envBin };
  }

  const pf = process.env.ProgramFiles ?? "C:\\Program Files";
  const pf86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
  const candidates = [
    path.join(pf, "Tailscale", "tailscale.exe"),
    path.join(pf86, "Tailscale", "tailscale.exe"),
  ];
  const pathEnv = process.env.PATH ?? "";
  for (const dir of pathEnv.split(path.delimiter)) {
    const trimmed = dir.trim();
    if (trimmed) candidates.push(path.join(trimmed, "tailscale.exe"));
  }
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return { cmd: candidate, prefix: [], binaryPath: candidate };
    }
  }
  return undefined;
}

function runTailscale(args: string[], timeoutMs = 15_000): Promise<ExecResult> {
  const inv = resolveTailscaleInvocation();
  if (!inv) {
    return Promise.resolve({ code: -1, stdout: "", stderr: "tailscale.exe 未安装" });
  }
  return new Promise((resolve) => {
    execFile(
      inv.cmd,
      [...inv.prefix, ...args],
      { windowsHide: true, timeout: timeoutMs },
      (error, stdout, stderr) => {
        const code =
          error && typeof (error as NodeJS.ErrnoException & { code?: unknown }).code === "number"
            ? Number((error as unknown as { code: number }).code)
            : error
              ? 1
              : 0;
        resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
      },
    );
  });
}

function parseFunnelActive(output: string, localPort: number): boolean {
  const trimmed = output.trim();
  if (!trimmed) return false;
  try {
    const parsed = JSON.parse(trimmed) as {
      AllowFunnel?: Record<string, unknown>;
      Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }>;
    };
    const hasAllow =
      !!parsed.AllowFunnel && Object.values(parsed.AllowFunnel).some((v) => v === true);
    if (!hasAllow) return false;
    const portSuffix = `:${localPort}`;
    if (!parsed.Web) return true;
    for (const hostEntry of Object.values(parsed.Web)) {
      for (const handler of Object.values(hostEntry.Handlers ?? {})) {
        if (typeof handler.Proxy === "string" && handler.Proxy.includes(portSuffix)) {
          return true;
        }
      }
    }
    return false;
  } catch {
    return /funnel on/i.test(trimmed) && trimmed.includes(`:${localPort}`);
  }
}

/** 检测本机 Tailscale 安装态、登录态、固定域名与当前 Funnel 暴露状态 */
export async function detectTailscale(localPort: number): Promise<TailscaleInfo> {
  const inv = resolveTailscaleInvocation();
  if (!inv) {
    return { installed: false, loggedIn: false, funnelActive: false };
  }

  const statusRes = await runTailscale(["status", "--json"], 6_000);
  if (statusRes.code !== 0 || !statusRes.stdout.trim()) {
    return {
      installed: true,
      loggedIn: false,
      funnelActive: false,
      binaryPath: inv.binaryPath,
      error: statusRes.stderr.trim() || "无法读取 Tailscale 状态",
    };
  }

  let dnsName = "";
  let running = false;
  try {
    const parsed = JSON.parse(statusRes.stdout) as {
      BackendState?: string;
      Self?: { DNSName?: string };
    };
    running = parsed.BackendState === "Running";
    dnsName = (parsed.Self?.DNSName ?? "").trim().replace(/\.+$/, "");
  } catch {
    return {
      installed: true,
      loggedIn: false,
      funnelActive: false,
      binaryPath: inv.binaryPath,
      error: "tailscale status --json 输出解析失败",
    };
  }

  if (!running || !dnsName) {
    return {
      installed: true,
      loggedIn: false,
      funnelActive: false,
      binaryPath: inv.binaryPath,
    };
  }

  const funnelRes = await runTailscale(["funnel", "status", "--json"], 6_000);
  const funnelActive = funnelRes.code === 0 && parseFunnelActive(funnelRes.stdout, localPort);
  return {
    installed: true,
    loggedIn: true,
    funnelActive,
    dnsName,
    url: `https://${dnsName}`,
    binaryPath: inv.binaryPath,
  };
}

/** 一键开启 Tailscale Funnel；若账号首次需在网页端点击授权开关，则捕获 approvalUrl 返回引导 */
export async function enableTailscaleFunnel(localPort: number): Promise<TailscaleInfo> {
  const detected = await detectTailscale(localPort);
  if (!detected.installed) {
    throw new Error("未检测到 Tailscale，请先安装并登录 Tailscale 客户端");
  }
  if (!detected.loggedIn || !detected.url) {
    throw new Error("Tailscale 尚未登录，请先在 Tailscale 客户端完成登录");
  }

  const res = await runTailscale(["funnel", "--bg", String(localPort)], 15_000);
  const combined = `${res.stdout}\n${res.stderr}`;
  const approvalMatch = combined.match(APPROVAL_URL_RE);
  if (approvalMatch) {
    logInfo("tailscale.funnel_approval_required", { url: approvalMatch[0] });
    return {
      ...detected,
      funnelActive: false,
      approvalUrl: approvalMatch[0],
      error: "需先在 Tailscale 后台点一下启用 Funnel，完成后再点「启动隧道」",
    };
  }
  if (res.code !== 0) {
    const detail = res.stderr.trim() || res.stdout.trim() || `退出码 ${res.code}`;
    throw new Error(`开启 Tailscale Funnel 失败：${detail}`);
  }

  logInfo("tailscale.funnel_enabled", { port: localPort, url: detected.url });
  return {
    ...detected,
    funnelActive: true,
    approvalUrl: undefined,
    error: undefined,
  };
}

/** 关闭 Tailscale Funnel 公网暴露 */
export async function disableTailscaleFunnel(): Promise<void> {
  const inv = resolveTailscaleInvocation();
  if (!inv) return;
  const res = await runTailscale(["funnel", "--https=443", "off"], 10_000);
  if (res.code !== 0) {
    logWarn("tailscale.funnel_disable_warn", { err: res.stderr.trim() || `code=${res.code}` });
    return;
  }
  logInfo("tailscale.funnel_disabled");
}
