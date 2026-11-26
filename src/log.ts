import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";
import path from "node:path";
import { appRoot, isPackaged } from "./paths.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogFieldValue = string | number | boolean | null | undefined;

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const LEVEL_TAG: Record<LogLevel, string> = {
  debug: "DEBUG",
  info: "INFO",
  warn: "WARN",
  error: "ERROR",
};

/** 进程内环形缓冲容量；面板默认取最近 100 行 */
const CAPACITY = 200;
/** 单日志文件默认 10 MB 切分滚动 */
const DEFAULT_MAX_FILE_BYTES = 10 * 1024 * 1024;
/** 日志目录最多保留的文件数 */
const DEFAULT_MAX_FILES = 10;
/** 仅清理本服务产出的滚动日志文件，不碰目录里其他文件 */
const LOG_FILE_PATTERN = /^nexus-mcp-\d{4}-\d{2}-\d{2}(?:\.\d+)?\.log$/;

export interface LoggerOptions {
  level?: LogLevel;
  /** 传 null 表示关闭磁盘落盘；传字符串表示落盘到指定目录；省略则保持现状 */
  logDir?: string | null;
  maxFileBytes?: number;
  maxFiles?: number;
  getSecret?: () => string;
  now?: () => Date;
  writeStderr?: (line: string) => void;
  resetRing?: boolean;
}

const lines: string[] = [];

let currentLevel: LogLevel = "info";
let currentLogDir: string | null = null;
let currentMaxFileBytes = DEFAULT_MAX_FILE_BYTES;
let currentMaxFiles = DEFAULT_MAX_FILES;
let currentGetSecret: () => string = () => "";
let currentNow: () => Date = () => new Date();
let currentWriteStderr: (line: string) => void = (line) => console.error(line);

/**
 * 解析服务日志目录，严格按优先级：
 * 1. NEXUS_MCP_LOG_DIR 环境变量
 * 2. 显式设置 NEXUS_MCP_CONFIG 时落 <配置所在目录>/logs/
 * 3. 开发态落 <仓库根>/.scratch/logs/
 * 4. 打包版落 <可执行文件同目录>/logs/
 */
export function resolveLogDir(options?: {
  env?: NodeJS.ProcessEnv;
  packaged?: boolean;
  rootDir?: string;
}): string {
  const env = options?.env ?? process.env;
  const packaged = options?.packaged ?? isPackaged;
  const rootDir = options?.rootDir ?? appRoot;

  const envLogDir = env.NEXUS_MCP_LOG_DIR?.trim();
  if (envLogDir) return path.resolve(envLogDir);

  const envConfig = env.NEXUS_MCP_CONFIG?.trim();
  if (envConfig) return path.join(path.dirname(path.resolve(envConfig)), "logs");

  return packaged ? path.join(rootDir, "logs") : path.join(rootDir, ".scratch", "logs");
}

/** 配置日志器（启动、配置重载或测试注入时调用） */
export function configureLogger(options: LoggerOptions): void {
  if (options.level !== undefined) currentLevel = options.level;
  if (options.logDir !== undefined) currentLogDir = options.logDir;
  if (options.maxFileBytes !== undefined) currentMaxFileBytes = options.maxFileBytes;
  if (options.maxFiles !== undefined) currentMaxFiles = options.maxFiles;
  if (options.getSecret !== undefined) currentGetSecret = options.getSecret;
  if (options.now !== undefined) currentNow = options.now;
  if (options.writeStderr !== undefined) currentWriteStderr = options.writeStderr;
  if (options.resetRing) lines.length = 0;

  if (currentLogDir) {
    try {
      mkdirSync(currentLogDir, { recursive: true });
      pruneLogFiles(currentLogDir, currentMaxFiles);
    } catch {
      // 落盘初始化失败不拦着服务启动，退回 stderr + 内存环
    }
  }
}

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

export function getLogLevel(): LogLevel {
  return currentLevel;
}

/** 抹除文本中的配置令牌以及 TOKEN= / PASSWORD= / SECRET= / KEY= / Bearer 形态 */
export function redactText(text: string, secret?: string): string {
  let result = text;
  const effectiveSecret = secret ?? currentGetSecret();
  if (effectiveSecret) {
    result = result.split(effectiveSecret).join("***");
  }
  result = result.replace(/\b(Bearer)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 ***");
  result = result.replace(
    /\b([A-Za-z0-9_]*?(?:TOKEN|PASSWORD|SECRET|KEY))\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'&;]+)/gi,
    "$1=***",
  );
  return result;
}

/** 压缩换行、先脱敏再截断到 maxChars，供工具摘要复用 */
export function summarizeText(text: string, maxChars: number, secret?: string): string {
  const singleLine = redactText(text, secret).replace(/[\r\n]+/g, " ").trim();
  if (singleLine.length <= maxChars) return singleLine;
  const truncated = `${singleLine.slice(0, Math.max(0, maxChars - 1))}…`;
  return redactText(truncated, secret);
}

function formatFieldValue(value: string | number | boolean): string {
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  const singleLine = redactText(value).replace(/[\r\n]+/g, " ");
  if (singleLine === "") return '""';
  if (/\s/.test(singleLine)) {
    return JSON.stringify(singleLine);
  }
  return singleLine;
}

function formatFields(fields?: Record<string, LogFieldValue>): string {
  if (!fields) return "";
  const parts: string[] = [];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null) continue;
    parts.push(`${key}=${formatFieldValue(value)}`);
  }
  return parts.join(" ");
}

function utcDateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function nextRotatedPath(dir: string, dateKey: string): string {
  for (let index = 1; ; index += 1) {
    const candidate = path.join(dir, `nexus-mcp-${dateKey}.${index}.log`);
    if (!existsSync(candidate)) return candidate;
  }
}

function pruneLogFiles(dir: string, maxFiles: number, keepFileName?: string): void {
  if (maxFiles < 1) return;
  let entries: string[];
  try {
    entries = readdirSync(dir).filter((name) => LOG_FILE_PATTERN.test(name));
  } catch {
    return;
  }
  if (entries.length <= maxFiles) return;

  const stats = entries
    .map((name) => {
      const fullPath = path.join(dir, name);
      try {
        return { name, fullPath, mtimeMs: statSync(fullPath).mtimeMs };
      } catch {
        return null;
      }
    })
    .filter((item): item is { name: string; fullPath: string; mtimeMs: number } => item !== null);

  // 最新修改的排在前面；同一毫秒内按文件名降序保证稳定
  stats.sort((a, b) => {
    if (b.mtimeMs !== a.mtimeMs) return b.mtimeMs - a.mtimeMs;
    return b.name.localeCompare(a.name);
  });

  const kept = new Set<string>();
  if (keepFileName) kept.add(keepFileName);
  for (const item of stats) {
    if (kept.size >= maxFiles) break;
    kept.add(item.name);
  }

  for (const item of stats) {
    if (!kept.has(item.name)) {
      try {
        unlinkSync(item.fullPath);
      } catch {
        // 清理失败不影响主流程
      }
    }
  }
}

function writeLineToDisk(dir: string, date: Date, line: string): void {
  const dateKey = utcDateKey(date);
  const activeName = `nexus-mcp-${dateKey}.log`;
  const activePath = path.join(dir, activeName);
  const payload = `${line}\n`;
  const payloadBytes = Buffer.byteLength(payload, "utf8");

  try {
    mkdirSync(dir, { recursive: true });
    let shouldPrune = false;
    if (existsSync(activePath)) {
      const currentSize = statSync(activePath).size;
      if (currentSize > 0 && currentSize + payloadBytes > currentMaxFileBytes) {
        const rotated = nextRotatedPath(dir, dateKey);
        renameSync(activePath, rotated);
        shouldPrune = true;
      }
    } else {
      shouldPrune = true;
    }
    appendFileSync(activePath, payload, "utf8");
    if (shouldPrune) {
      pruneLogFiles(dir, currentMaxFiles, activeName);
    }
  } catch {
    // 写盘失败静默降级，保证服务继续运行
  }
}

/** 写入一条结构化服务日志：三处（stderr / 内存环 / 磁盘）共用同一阈值与脱敏规则 */
export function logEvent(
  level: LogLevel,
  event: string,
  fields?: Record<string, LogFieldValue>,
  message?: string,
): void {
  if (LEVEL_RANK[level] < LEVEL_RANK[currentLevel]) return;

  const date = currentNow();
  const fieldText = formatFields(fields);
  const msgText = message ? message.replace(/[\r\n]+/g, " ").trim() : "";
  const tail = [fieldText, msgText].filter(Boolean).join(" ");
  const rawLine = `${date.toISOString()} [${LEVEL_TAG[level]}] [${event}]${tail ? ` ${tail}` : ""}`;
  const line = redactText(rawLine);

  lines.push(line);
  if (lines.length > CAPACITY) lines.splice(0, lines.length - CAPACITY);

  currentWriteStderr(`[nexus-mcp] ${line}`);
  if (currentLogDir) {
    writeLineToDisk(currentLogDir, date, line);
  }
}

export function logDebug(event: string, fields?: Record<string, LogFieldValue>, message?: string): void {
  logEvent("debug", event, fields, message);
}

export function logInfo(event: string, fields?: Record<string, LogFieldValue>, message?: string): void {
  logEvent("info", event, fields, message);
}

export function logWarn(event: string, fields?: Record<string, LogFieldValue>, message?: string): void {
  logEvent("warn", event, fields, message);
}

export function logError(event: string, fields?: Record<string, LogFieldValue>, message?: string): void {
  logEvent("error", event, fields, message);
}

/** 兼容旧调用的简易日志入口（INFO 级 service 事件） */
export function log(message: string): void {
  logEvent("info", "service", undefined, message);
}

/** 面板只取最近 100 行 */
export function recentLogs(count = 100): string[] {
  return lines.slice(-count);
}
