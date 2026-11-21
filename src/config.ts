import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type ShellKind = "auto" | "git-bash" | "pwsh" | "powershell";

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
  /** 隧道公网地址，配了面板才会去探测连通性 */
  tunnelUrl?: string;
}

const DEFAULTS: Omit<AppConfig, "root" | "panelPort"> = {
  transport: "http",
  // 与已有的 cloudflared 隧道配置保持一致（nexus.maliy.top → 127.0.0.1:8787），
  // 这样接管时隧道配置不需要改动。
  port: 8787,
  token: "",
  shell: "auto",
  maxOutputBytes: 64 * 1024,
  defaultTimeoutMs: 120_000,
};

export function configFilePath(): string {
  const override = process.env.NEXUS_MCP_CONFIG;
  if (override && override.trim()) return path.resolve(override);
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "config.json");
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

  return {
    root,
    transport: raw.transport === "stdio" ? "stdio" : DEFAULTS.transport,
    port,
    panelPort: Number.isInteger(raw.panelPort) ? (raw.panelPort as number) : port + 1,
    token: typeof raw.token === "string" ? raw.token : DEFAULTS.token,
    shell: raw.shell ?? DEFAULTS.shell,
    maxOutputBytes: raw.maxOutputBytes ?? DEFAULTS.maxOutputBytes,
    defaultTimeoutMs: raw.defaultTimeoutMs ?? DEFAULTS.defaultTimeoutMs,
    ...(typeof raw.tunnelUrl === "string" && raw.tunnelUrl.trim()
      ? { tunnelUrl: raw.tunnelUrl.trim() }
      : {}),
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
