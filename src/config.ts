import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { appRoot, isPackaged } from "./paths.js";
import { log } from "./log.js";

export type ShellKind = "auto" | "git-bash" | "pwsh" | "powershell";

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
  /** 命令闸门：白/黑名单与未命中策略，原样透传给执行器 */
  commandPolicy: CommandPolicyConfig;
  /** 隧道公网地址，配了面板才会去探测连通性 */
  tunnelUrl?: string;
  /** 本机 cloudflared 隧道管理；配置了这个段面板才提供启停按钮 */
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
      "config.json 的 tunnel 应是对象（{ cloudflaredPath?, configPath?, autoRestart?, metricsPort? }）",
    );
  }
  const { cloudflaredPath, configPath, autoRestart, metricsPort } = raw as Record<string, unknown>;
  for (const [key, value] of [
    ["cloudflaredPath", cloudflaredPath],
    ["configPath", configPath],
  ] as const) {
    if (value !== undefined && (typeof value !== "string" || !value.trim())) {
      throw new Error(`config.json 的 tunnel.${key} 必须是非空字符串`);
    }
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

/** shell 配置在启动时校验，坏了直接不让服务起来；面板快捷设置保存前也走这道校验 */
export function validateShell(shell: ShellKind): void {
  if (shell === "powershell") {
    throw new Error(
      "shell 配置为 powershell（Windows PowerShell 5.1）不受支持：5.1 的控制台编码跟随系统代码页，" +
        "中文系统下子进程输出会乱码，无法满足工具输出一律 UTF-8 的约定。" +
        "请把 config.json 里的 shell 改成 pwsh（PowerShell 7）或 git-bash。",
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

/**
 * 读配置。优先级：环境变量 > 可执行文件同目录的 config.json > 内置默认。
 * 文件不存在时先按默认值生成一份，不让首次运行直接崩。
 */
export function loadConfig(): AppConfig {
  const file = configFilePath();
  let raw: Partial<AppConfig> = {};

  if (existsSync(file)) {
    try {
      raw = JSON.parse(readFileSync(file, "utf8")) as Partial<AppConfig>;
    } catch (err) {
      throw new Error(`config.json 解析失败 (${file}): ${(err as Error).message}`);
    }
  } else {
    raw = writeInitialConfig(file);
  }

  // 环境变量只认非空值：空串按未设置处理，避免 PowerShell 里 `$env:X=""` 的误伤
  const envRoot = process.env.NEXUS_MCP_ROOT?.trim();
  const envToken = process.env.NEXUS_MCP_TOKEN;
  const envPort = Number(process.env.NEXUS_MCP_PORT);

  const root = path.resolve(envRoot || raw.root || defaultRoot());
  const port = Number.isInteger(envPort) && envPort > 0
    ? envPort
    : Number.isInteger(raw.port)
      ? (raw.port as number)
      : DEFAULTS.port;
  const shell = raw.shell ?? DEFAULTS.shell;
  validateShell(shell);
  const tunnel = normalizeTunnel(raw.tunnel);

  return {
    root,
    transport: raw.transport === "stdio" ? "stdio" : DEFAULTS.transport,
    port,
    panelPort: Number.isInteger(raw.panelPort) ? (raw.panelPort as number) : port + 1,
    token: envToken ? envToken : typeof raw.token === "string" ? raw.token : DEFAULTS.token,
    shell,
    maxOutputBytes: raw.maxOutputBytes ?? DEFAULTS.maxOutputBytes,
    defaultTimeoutMs: raw.defaultTimeoutMs ?? DEFAULTS.defaultTimeoutMs,
    commandPolicy: normalizeCommandPolicy(raw.commandPolicy),
    ...(typeof raw.tunnelUrl === "string" && raw.tunnelUrl.trim()
      ? { tunnelUrl: raw.tunnelUrl.trim() }
      : {}),
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
    commandPolicy: config.commandPolicy,
  };
  // 可选键：配置里已不存在时要把旧键从文件里清掉，否则 {...raw} 会把它一直带着
  if (config.tunnelUrl) next.tunnelUrl = config.tunnelUrl;
  else delete next.tunnelUrl;
  if (config.tunnel) next.tunnel = config.tunnel;
  else delete next.tunnel;

  writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, "utf8");
}

/** 把用户传入的路径解析成根目录内的绝对路径，越界直接拒绝 */
export function resolveInRoot(root: string, input: string): string {
  if (!input || input.trim() === "") throw new Error("path 不能为空");
  const abs = path.isAbsolute(input) ? path.normalize(input) : path.resolve(root, input);
  const rel = path.relative(root, abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`路径越界，只允许访问 ${root} 以内的文件: ${input}`);
  }
  return abs;
}

/** 相对根目录展示，便于把结果喂给模型时更短 */
export function displayPath(root: string, abs: string): string {
  const rel = path.relative(root, abs);
  return rel === "" ? "." : rel.split(path.sep).join("/");
}
