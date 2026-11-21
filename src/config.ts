import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type ShellKind = "auto" | "git-bash" | "pwsh" | "powershell";

export interface CommandPolicyConfig {
  /** 白名单：通配模式（如 "git push *"），非空时启用白名单 */
  allow: string[];
  /** 黑名单：通配模式，命中即拒绝 */
  deny: string[];
  /** 白名单非空且命令未命中时的处理，默认 deny */
  onUnmatched: "deny" | "allow";
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
function normalizeCommandPolicy(raw: unknown): CommandPolicyConfig {
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

export function configFilePath(): string {
  const override = process.env.NEXUS_MCP_CONFIG;
  if (override && override.trim()) return path.resolve(override);
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "config.json");
}

/** 默认 Git Bash 路径；可用环境变量 NEXUS_GIT_BASH 覆盖（测试用） */
export function gitBashPath(): string {
  const override = process.env.NEXUS_GIT_BASH;
  if (override && override.trim()) return path.resolve(override.trim());
  const programFiles = process.env.ProgramFiles ?? "C:\\Program Files";
  return path.join(programFiles, "Git", "bin", "bash.exe");
}

/** shell 配置在启动时校验，坏了直接不让服务起来 */
function validateShell(shell: ShellKind): void {
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
      throw new Error(
        `找不到 Git Bash（${bash}）。请安装 Git for Windows，或在 config.json 里显式指定 shell 为 pwsh。`,
      );
    }
  }
}

export function loadConfig(): AppConfig {
  const file = configFilePath();
  let raw: Partial<AppConfig> = {};

  if (existsSync(file)) {
    try {
      raw = JSON.parse(readFileSync(file, "utf8")) as Partial<AppConfig>;
    } catch (err) {
      throw new Error(`config.json 解析失败 (${file}): ${(err as Error).message}`);
    }
  }

  const root = path.resolve(raw.root ?? process.cwd());
  const port = Number.isInteger(raw.port) ? (raw.port as number) : DEFAULTS.port;
  const shell = raw.shell ?? DEFAULTS.shell;
  validateShell(shell);

  return {
    root,
    transport: raw.transport === "stdio" ? "stdio" : DEFAULTS.transport,
    port,
    panelPort: Number.isInteger(raw.panelPort) ? (raw.panelPort as number) : port + 1,
    token: typeof raw.token === "string" ? raw.token : DEFAULTS.token,
    shell,
    maxOutputBytes: raw.maxOutputBytes ?? DEFAULTS.maxOutputBytes,
    defaultTimeoutMs: raw.defaultTimeoutMs ?? DEFAULTS.defaultTimeoutMs,
    commandPolicy: normalizeCommandPolicy(raw.commandPolicy),
    ...(typeof raw.tunnelUrl === "string" && raw.tunnelUrl.trim()
      ? { tunnelUrl: raw.tunnelUrl.trim() }
      : {}),
  };
}

/** 把当前配置写回 config.json，保留文件里本程序不认识的键 */
export function saveConfig(config: AppConfig): void {  const file = configFilePath();
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
  if (config.tunnelUrl) next.tunnelUrl = config.tunnelUrl;

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
