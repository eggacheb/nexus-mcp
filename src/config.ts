import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { appRoot, isPackaged } from "./paths.js";
import { log } from "./log.js";
import type { LogLevel } from "./log.js";

export type { LogLevel } from "./log.js";
export type ShellKind = "auto" | "git-bash" | "pwsh" | "powershell";
export type TunnelMode = "none" | "quick" | "tailscale" | "named";

const VALID_LOG_LEVELS: ReadonlySet<string> = new Set<LogLevel>(["debug", "info", "warn", "error"]);
const VALID_TUNNEL_MODES: ReadonlySet<string> = new Set<TunnelMode>(["none", "quick", "tailscale", "named"]);

export interface CommandPolicyConfig {
  /** 白名单：通配模式（如 "git push *"），非空时启用白名单 */
  allow: string[];
  /** 黑名单：通配模式，命中即拒绝 */
  deny: string[];
  /** 白名单非空且命令未命中时的处理，默认 deny */
  onUnmatched: "deny" | "allow";
}

export interface TunnelConfig {
  /** cloudflared 可执行文件路径，默认 Program Files (x86) 下的安装位置 */
  cloudflaredPath?: string;
  /** 隧道配置（ingress）路径，默认 %USERPROFILE%\.cloudflared\config.yml */
  configPath?: string;
  /** 启动服务时自动拉起隧道，默认开启 */
  autoStart?: boolean;
  /** 进程异常退出后自动重启（守护），默认开启 */
  autoRestart?: boolean;
  /** cloudflared 本地 metrics 端口，默认 20241（cloudflared 自己的默认监听端口） */
  metricsPort?: number;
}

export interface AppConfig {
  /** 唯一允许访问的根目录，绝对路径 */
  root: string;
  /** stdio 给本机客户端，http 给云端 AI */
  transport: "stdio" | "http";
  port: number;
  /** 本地面板端口，默认 port + 1；面板与 MCP 分开监听，停服务时面板不掉线 */
  panelPort: number;
  /** http 模式的 Bearer token，空串表示不校验（仅限本机调试） */
  token: string;
  shell: ShellKind;
  /** 单个工具返回内容的上限，超出部分截断 */
  maxOutputBytes: number;
  /** 单条命令默认超时 */
  defaultTimeoutMs: number;
  /** 服务日志输出阈值，默认 info */
  logLevel: LogLevel;
  /** 命令闸门：白/黑名单与未命中策略，原样透传给执行器 */
  commandPolicy: CommandPolicyConfig;
  /** 隧道公网地址（命名隧道固定地址），配了面板才会去探测连通性 */
  tunnelUrl?: string;
  /** Tailscale Funnel 固定公网地址（与命名隧道 tunnelUrl 独立存储，切换不互相覆盖） */
  tailscaleUrl?: string;
  /** 激活的公网隧道渠道：单通道互斥；省略时有 tunnel 段推导为 named，否则 none */
  tunnelMode?: TunnelMode;
  /** 本机 cloudflared 命名隧道管理；配置了这个段面板才提供命名隧道启停 */
  tunnel?: TunnelConfig;
}

const DEFAULTS: Omit<AppConfig, "root" | "panelPort" | "commandPolicy"> = {
  transport: "http",
  // 与已有的 cloudflared 隧道配置保持一致（nexus.maliy.top → 127.0.0.1:8787），
  // 这样接管时隧道配置不需要改动。
  port: 8787,
  token: "",
  shell: "auto",
  maxOutputBytes: 64 * 1024,
  defaultTimeoutMs: 120_000,
  logLevel: "info",
};

/** 命令闸门配置校验：形状不对启动即报错，不带着坏配置起服务 */
export function normalizeCommandPolicy(raw: unknown): CommandPolicyConfig {
  if (raw === undefined || raw === null) {
    return { allow: [], deny: [], onUnmatched: "deny" };
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("config.json 的 commandPolicy 应是对象（{ allow, deny, onUnmatched }）");
  }
  const { allow, deny, onUnmatched } = raw as Record<string, unknown>;
  const stringList = (value: unknown, field: string): string[] => {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
      throw new Error(`config.json 的 commandPolicy.${field} 必须是字符串数组`);
    }
    return (value as string[]).map((item) => item.trim()).filter((item) => item !== "");
  };
  const unmatched = onUnmatched ?? "deny";
  if (unmatched !== "deny" && unmatched !== "allow") {
    throw new Error(
      `config.json 的 commandPolicy.onUnmatched 只支持 "deny" 或 "allow"，当前值: ${JSON.stringify(onUnmatched)}`,
    );
  }
  return { allow: stringList(allow, "allow"), deny: stringList(deny, "deny"), onUnmatched: unmatched };
}

/** 隧道管理配置校验：形状不对启动即报错 */
function normalizeTunnel(raw: unknown): TunnelConfig | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(
      "config.json 的 tunnel 应是对象（{ cloudflaredPath?, configPath?, autoStart?, autoRestart?, metricsPort? }）",
    );
  }
  const { cloudflaredPath, configPath, autoStart, autoRestart, metricsPort } = raw as Record<string, unknown>;
  for (const [key, value] of [
    ["cloudflaredPath", cloudflaredPath],
    ["configPath", configPath],
  ] as const) {
    if (value !== undefined && (typeof value !== "string" || !value.trim())) {
      throw new Error(`config.json 的 tunnel.${key} 必须是非空字符串`);
    }
  }
  if (autoStart !== undefined && typeof autoStart !== "boolean") {
    throw new Error("config.json 的 tunnel.autoStart 必须是布尔值");
  }
  if (autoRestart !== undefined && typeof autoRestart !== "boolean") {
    throw new Error("config.json 的 tunnel.autoRestart 必须是布尔值");
  }
  if (
    metricsPort !== undefined &&
    (typeof metricsPort !== "number" || !Number.isInteger(metricsPort) || metricsPort < 1 || metricsPort > 65535)
  ) {
    throw new Error("config.json 的 tunnel.metricsPort 必须是 1-65535 的整数");
  }
  const result: TunnelConfig = {};
  if (typeof cloudflaredPath === "string" && cloudflaredPath.trim()) {
    result.cloudflaredPath = cloudflaredPath.trim();
  }
  if (typeof configPath === "string" && configPath.trim()) result.configPath = configPath.trim();
  if (typeof autoStart === "boolean") result.autoStart = autoStart;
  if (typeof autoRestart === "boolean") result.autoRestart = autoRestart;
  if (typeof metricsPort === "number") result.metricsPort = metricsPort;
  return result;
}

/**
 * 配置文件位置：环境变量 NEXUS_MCP_CONFIG 显式指定优先，
 * 否则取程序根目录（打包版是 exe 同目录，开发态是仓库根）。
 */
export function configFilePath(): string {
  const override = process.env.NEXUS_MCP_CONFIG;
  if (override && override.trim()) return path.resolve(override);
  return path.join(appRoot, "config.json");
}

/** 没配 root 时的沙箱根：打包版固定为 exe 同目录的 workspace，开发态沿用当前目录 */
function defaultRoot(): string {
  if (!isPackaged) return process.cwd();
  const workspace = path.join(appRoot, "workspace");
  try {
    mkdirSync(workspace, { recursive: true });
  } catch (error) {
    // 目录建不出来（只读安装位置之类）也别拦着服务起来，第一次 read/write 会报真因
    log(`创建 workspace 失败（${workspace}）：${(error as Error).message}`);
  }
  return workspace;
}

/**
 * 首次运行（没有 config.json）生成默认配置：令牌随机，用户照着填进云端连接器。
 * 写盘失败不拦着服务起来，退回相同的内置值继续跑。
 */
function writeInitialConfig(file: string): Partial<AppConfig> {
  const initial: Partial<AppConfig> = {
    root: defaultRoot(),
    transport: DEFAULTS.transport,
    port: DEFAULTS.port,
    panelPort: DEFAULTS.port + 1,
    token: randomBytes(16).toString("hex"),
    shell: DEFAULTS.shell,
    maxOutputBytes: DEFAULTS.maxOutputBytes,
    defaultTimeoutMs: DEFAULTS.defaultTimeoutMs,
    commandPolicy: { allow: [], deny: [], onUnmatched: "deny" },
  };
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(initial, null, 2)}\n`, "utf8");
    log(`首次运行，已生成默认配置: ${file}`);
    log(`访问令牌（token 字段）：${initial.token} —— 填进云端连接器的 Bearer 令牌，之后可在该文件里改`);
  } catch (error) {
    log(`默认配置写入失败（${file}）：${(error as Error).message}，本次按内置默认值运行`);
  }
  return initial;
}

/** 默认 Git Bash 路径；可用环境变量 NEXUS_GIT_BASH 覆盖（测试用） */
export function gitBashPath(): string {
  const override = process.env.NEXUS_GIT_BASH;
  if (override && override.trim()) return path.resolve(override.trim());
  const programFiles = process.env.ProgramFiles ?? "C:\\Program Files";
  return path.join(programFiles, "Git", "bin", "bash.exe");
}

/** 正整数配置字段校验（loadConfig 与面板快捷设置同源复用） */
export function normalizePositiveInt(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`config.json 的 ${field} 必须是正整数`);
  }
  return value;
}

/** 日志等级校验（loadConfig 与面板快捷设置同源复用） */
export function normalizeLogLevel(value: unknown, sourceLabel = "config.json 的 logLevel"): LogLevel {
  if (typeof value !== "string" || !VALID_LOG_LEVELS.has(value)) {
    throw new Error(
      `${sourceLabel} 只支持 "debug" / "info" / "warn" / "error"，收到 ${JSON.stringify(value)}`,
    );
  }
  return value as LogLevel;
}

/** 隧道公网地址校验：允许省略或置空，非空时不得包含空白字符 */
export function normalizeTunnelUrl(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new Error("config.json 的 tunnelUrl 必须是字符串");
  }
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (/\s/.test(trimmed)) {
    throw new Error("config.json 的 tunnelUrl 不能包含空白字符");
  }
  return trimmed;
}

/** 隧道渠道模式校验：省略时按 config.tunnel 是否存在向后兼容推导 */
export function normalizeTunnelMode(value: unknown): TunnelMode | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !VALID_TUNNEL_MODES.has(value)) {
    throw new Error(
      `config.json 的 tunnelMode 只支持 "none" / "quick" / "tailscale" / "named"，收到 ${JSON.stringify(value)}`,
    );
  }
  return value as TunnelMode;
}

/** 生效中的单通道模式：老用户未写 tunnelMode 但已有 tunnel 段时默认保持 named */
export function effectiveTunnelMode(config: Pick<AppConfig, "tunnelMode" | "tunnel">): TunnelMode {
  if (config.tunnelMode) return config.tunnelMode;
  return config.tunnel ? "named" : "none";
}

/** 原地替换共享 AppConfig 的全部键，清理磁盘配置中已删除的可选字段（如 tunnelUrl / tunnel） */
export function replaceConfigInPlace(target: AppConfig, next: AppConfig): void {
  for (const key of Object.keys(target) as Array<keyof AppConfig>) {
    delete target[key];
  }
  Object.assign(target, next);
}

/** shell 配置在启动时校验，坏了直接不让服务起来；面板快捷设置保存前也走这道校验 */
export function validateShell(shell: unknown): asserts shell is "auto" | "git-bash" | "pwsh" {
  if (shell === "powershell") {
    throw new Error(
      "shell 配置为 powershell（Windows PowerShell 5.1）不受支持：5.1 的控制台编码跟随系统代码页，" +
        "中文系统下子进程输出会乱码，无法满足工具输出一律 UTF-8 的约定。" +
        "请把 config.json 里的 shell 改成 pwsh（PowerShell 7）或 git-bash。",
    );
  }
  if (shell !== "auto" && shell !== "git-bash" && shell !== "pwsh") {
    throw new Error(
      `config.json 的 shell 只支持 "auto" / "git-bash" / "pwsh"，收到 ${JSON.stringify(shell)}`,
    );
  }
  if (shell === "auto" || shell === "git-bash") {
    const bash = gitBashPath();
    if (!existsSync(bash)) {
      // 显式选了 git-bash 就是用户点名要它，缺了必须报错。
      // auto 在打包版里降级成警告：没装过开发工具链的机器也要能先跑文件类工具，
      // bash / job_* 等真要用 shell 的时候再由 resolveShell 报错。
      if (shell === "git-bash" || !isPackaged) {
        throw new Error(
          `找不到 Git Bash（${bash}）。请安装 Git for Windows，或在 config.json 里显式指定 shell 为 pwsh。`,
        );
      }
      log(
        `没找到 Git Bash（${bash}）：bash 与 job_* 会报错，read/write/edit/glob/grep 不受影响。` +
          "需要命令执行时装一个 Git for Windows，或在 config.json 里把 shell 改成 pwsh。",
      );
    }
  }
}

function normalizePort(value: unknown, field: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(`config.json 的 ${field} 必须是 1-65535 的整数`);
  }
  return value;
}

function normalizeToken(value: unknown, sourceLabel: string): string {
  if (typeof value !== "string") {
    throw new Error(`${sourceLabel} 的 token 必须是字符串`);
  }
  if (value === "") return "";
  if (/\s/.test(value)) {
    throw new Error(`${sourceLabel} 的 token 不能包含空白字符（本机免鉴权请设为空字符串 ""）`);
  }
  return value;
}

/**
 * 读配置。优先级：环境变量 > 可执行文件同目录的 config.json > 内置默认。
 * 文件不存在时先按默认值生成一份，不让首次运行直接崩。
 */
export function loadConfig(): AppConfig {
  const file = configFilePath();
  let raw: Record<string, unknown> = {};

  if (existsSync(file)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(file, "utf8"));
    } catch (err) {
      throw new Error(`config.json 解析失败 (${file}): ${(err as Error).message}`);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`config.json 顶层必须是 JSON 对象 (${file})`);
    }
    raw = parsed as Record<string, unknown>;
  } else {
    raw = writeInitialConfig(file) as Record<string, unknown>;
  }

  if (raw.root !== undefined && (typeof raw.root !== "string" || !raw.root.trim())) {
    throw new Error("config.json 的 root 必须是非空字符串");
  }
  if (raw.transport !== undefined && raw.transport !== "http" && raw.transport !== "stdio") {
    throw new Error(`config.json 的 transport 只支持 "http" 或 "stdio"，收到 ${JSON.stringify(raw.transport)}`);
  }
  const fileToken =
    raw.token !== undefined ? normalizeToken(raw.token, "config.json") : DEFAULTS.token;

  // 环境变量只认非空值：空串按未设置处理，避免 PowerShell 里 `$env:X=""` 的误伤
  const envRoot = process.env.NEXUS_MCP_ROOT?.trim();
  const rawEnvToken = process.env.NEXUS_MCP_TOKEN;
  const token =
    rawEnvToken !== undefined && rawEnvToken !== ""
      ? normalizeToken(rawEnvToken, "环境变量 NEXUS_MCP_TOKEN")
      : fileToken;
  const rawEnvPort = process.env.NEXUS_MCP_PORT?.trim();

  const root = path.resolve(envRoot || (raw.root as string | undefined) || defaultRoot());
  const port = rawEnvPort
    ? normalizePort(Number(rawEnvPort), "NEXUS_MCP_PORT", DEFAULTS.port)
    : normalizePort(raw.port, "port", DEFAULTS.port);
  if (raw.panelPort === undefined && port >= 65535) {
    throw new Error(
      "config.json 的 port 为 65535 时无法自动推导 panelPort（port + 1 越界），请显式指定 1-65534 的 panelPort",
    );
  }
  const panelPort = normalizePort(raw.panelPort, "panelPort", port + 1);
  if (panelPort === port) {
    throw new Error(`config.json 的 port 与 panelPort 不能相同（均为 ${port}）`);
  }
  const shell = raw.shell ?? DEFAULTS.shell;
  validateShell(shell);
  const maxOutputBytes =
    raw.maxOutputBytes !== undefined
      ? normalizePositiveInt(raw.maxOutputBytes, "maxOutputBytes")
      : DEFAULTS.maxOutputBytes;
  const defaultTimeoutMs =
    raw.defaultTimeoutMs !== undefined
      ? normalizePositiveInt(raw.defaultTimeoutMs, "defaultTimeoutMs")
      : DEFAULTS.defaultTimeoutMs;
  const fileLogLevel =
    raw.logLevel !== undefined ? normalizeLogLevel(raw.logLevel) : DEFAULTS.logLevel;
  const rawEnvLogLevel = process.env.NEXUS_MCP_LOG_LEVEL?.trim();
  const logLevel = rawEnvLogLevel
    ? normalizeLogLevel(rawEnvLogLevel, "环境变量 NEXUS_MCP_LOG_LEVEL")
    : fileLogLevel;
  const tunnelUrl = normalizeTunnelUrl(raw.tunnelUrl);
  const tailscaleUrl = normalizeTunnelUrl(raw.tailscaleUrl);
  const tunnelMode = normalizeTunnelMode(raw.tunnelMode);
  const tunnel = normalizeTunnel(raw.tunnel);

  return {
    root,
    transport: raw.transport === "stdio" ? "stdio" : DEFAULTS.transport,
    port,
    panelPort,
    token,
    shell,
    maxOutputBytes,
    defaultTimeoutMs,
    logLevel,
    commandPolicy: normalizeCommandPolicy(raw.commandPolicy),
    ...(tunnelUrl ? { tunnelUrl } : {}),
    ...(tailscaleUrl ? { tailscaleUrl } : {}),
    ...(tunnelMode ? { tunnelMode } : {}),
    ...(tunnel ? { tunnel } : {}),
  };
}

/** 把当前配置写回 config.json，保留文件里本程序不认识的键 */
export function saveConfig(config: AppConfig): void {
  const file = configFilePath();
  let raw: Record<string, unknown> = {};
  if (existsSync(file)) {
    try {
      raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    } catch {
      raw = {};
    }
  }

  const next: Record<string, unknown> = {
    ...raw,
    root: config.root,
    transport: config.transport,
    port: config.port,
    panelPort: config.panelPort,
    token: config.token,
    shell: config.shell,
    maxOutputBytes: config.maxOutputBytes,
    defaultTimeoutMs: config.defaultTimeoutMs,
    logLevel: config.logLevel,
    commandPolicy: config.commandPolicy,
  };
  // 可选键：配置里已不存在时要把旧键从文件里清掉，否则 {...raw} 会把它一直带着
  if (config.tunnelUrl) next.tunnelUrl = config.tunnelUrl;
  else delete next.tunnelUrl;
  if (config.tailscaleUrl) next.tailscaleUrl = config.tailscaleUrl;
  else delete next.tailscaleUrl;
  if (config.tunnelMode) next.tunnelMode = config.tunnelMode;
  else delete next.tunnelMode;
  if (config.tunnel) next.tunnel = config.tunnel;
  else delete next.tunnel;

  writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, "utf8");
}
