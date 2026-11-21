import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type ShellKind = "auto" | "git-bash" | "pwsh" | "powershell";

export interface AppConfig {
  /** 唯一允许访问的根目录，绝对路径 */
  root: string;
  /** stdio 给本机客户端，http 给云端 AI */
  transport: "stdio" | "http";
  port: number;
  /** http 模式的 Bearer token，空串表示不校验（仅限本机调试） */
  token: string;
  shell: ShellKind;
  /** 单个工具返回内容的上限，超出部分截断 */
  maxOutputBytes: number;
  /** 单条命令默认超时 */
  defaultTimeoutMs: number;
}

const DEFAULTS: Omit<AppConfig, "root"> = {
  transport: "http",
  port: 8790,
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

  return {
    root,
    transport: raw.transport === "stdio" ? "stdio" : DEFAULTS.transport,
    port: Number.isInteger(raw.port) ? (raw.port as number) : DEFAULTS.port,
    token: typeof raw.token === "string" ? raw.token : DEFAULTS.token,
    shell: raw.shell ?? DEFAULTS.shell,
    maxOutputBytes: raw.maxOutputBytes ?? DEFAULTS.maxOutputBytes,
    defaultTimeoutMs: raw.defaultTimeoutMs ?? DEFAULTS.defaultTimeoutMs,
  };
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
