import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gitBashPath } from "./config.js";
import type { AppConfig } from "./config.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export interface ShellSpec {
  kind: "git-bash" | "pwsh";
  program: string;
}

export interface BashSuccess {
  ok: true;
  exit_code: number;
  timed_out?: false;
  output: string;
}

export interface BashTimeout {
  ok: true;
  exit_code: null;
  timed_out: true;
  output: string;
}

export interface BashFailure {
  ok: false;
  error: string;
}

export type BashResponse = BashSuccess | BashTimeout | BashFailure;

export interface ReadSuccess {
  ok: true;
  /** 带行号的文件内容片段（行号右对齐 6 位 + tab），无尾部换行 */
  content: string;
  /** 文件总行数 */
  total_lines: number;
  /** 本次返回的第一行行号（1 起）；无内容时为 0 */
  start_line: number;
  /** 本次返回的最后一行行号；无内容时为 0 */
  end_line: number;
  /** 因字节上限未显示的行数 */
  omitted_lines: number;
}

export interface WriteSuccess {
  ok: true;
  /** 实际落盘字节数（UTF-8） */
  bytes_written: number;
}

export interface EditSuccess {
  ok: true;
  /** 实际替换的处数（replace_all 时为全部匹配数） */
  replacements: number;
  /** 首处替换在原文件中的行号范围（1 起，含端点，与 read 行号一致） */
  start_line: number;
  end_line: number;
  /** 编辑后的文件总行数 */
  total_lines: number;
}

export interface ExecutorFailure {
  ok: false;
  error: string;
}

export interface GlobSuccess {
  ok: true;
  /** 匹配的文件路径（相对沙箱根，正斜杠），按修改时间从新到旧 */
  paths: string[];
  /** 全部匹配数（截断前） */
  total_matches: number;
  /** 结果超过单次上限被截断 */
  truncated: boolean;
}

export interface GrepMatch {
  /** 文件路径（相对沙箱根，正斜杠） */
  path: string;
  /** 1 起的行号 */
  line: number;
  /** 匹配行内容（超长行已截断） */
  text: string;
}

export interface GrepSuccess {
  ok: true;
  matches: GrepMatch[];
  /** 匹配数超过单次上限被截断 */
  truncated: boolean;
}

export type ReadResponse = ReadSuccess | ExecutorFailure;
export type WriteResponse = WriteSuccess | ExecutorFailure;
export type EditResponse = EditSuccess | ExecutorFailure;
export type GlobResponse = GlobSuccess | ExecutorFailure;
export type GrepResponse = GrepSuccess | ExecutorFailure;

export interface JobStartSuccess {
  ok: true;
  /** 任务 id，形如 job-1 */
  job_id: string;
  /** 任务主进程 pid */
  pid: number;
}

export interface JobOutputSuccess {
  ok: true;
  job_id: string;
  /** running 表示任务还在跑；exited 表示已结束（failed 不会出现：启动失败在 job_start 直接报错） */
  status: "running" | "exited";
  /** 结束后为退出码；运行中为 null */
  exit_code: number | null;
  /** 本次增量输出（请求落在已丢弃区间时为省略标注文本） */
  output: string;
  /** 下一次 job_output 应传的字节偏移 */
  next_offset: number;
  /** 迄今产生的总字节数 */
  total_bytes: number;
  /** 缓冲内已丢弃、无法再读到的字节数 */
  omitted_bytes: number;
}

export type JobStartResponse = JobStartSuccess | ExecutorFailure;
export type JobOutputResponse = JobOutputSuccess | ExecutorFailure;

/** 执行器二进制路径；NEXUS_MCP_EXECUTOR 可覆盖（测试用来注入假执行器） */
export function executorBinaryPath(): string {
  const override = process.env.NEXUS_MCP_EXECUTOR;
  if (override && override.trim()) return path.resolve(override.trim());
  return releaseBinaryPath("nexus-executor");
}

/** 测试辅助 bin：模拟执行器启动即崩溃，随 npm run build:executor 一并构建 */
export function crashHelperBinaryPath(): string {
  return releaseBinaryPath("crash-helper");
}

function releaseBinaryPath(name: string): string {
  const suffix = process.platform === "win32" ? ".exe" : "";
  return path.join(projectRoot, "crates", "target", "release", `${name}${suffix}`);
}

/** shell 配置 → 具体执行程序。powershell(5.1) 在 loadConfig 启动校验时就被拒绝 */
export function resolveShell(config: AppConfig): ShellSpec {
  if (config.shell === "pwsh") return { kind: "pwsh", program: "pwsh" };
  // auto 与 git-bash：loadConfig 已确保 Git Bash 存在
  return { kind: "git-bash", program: gitBashPath() };
}

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

/** 执行器协议客户端：单行 JSON over stdio，请求带自增 id，同一时间只发一个请求 */
export class ExecutorClient {
  private child: ChildProcess | null = null;
  private lineBuffer = "";
  private stderrTail = "";
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private queue: Promise<unknown> = Promise.resolve();

  /** 串行发送：所有请求排队，避免协议层与执行器的响应错位 */
  request<T>(payload: Record<string, unknown>): Promise<T> {
    const run = (): Promise<T> => this.dispatch<T>(payload);
    const result = this.queue.then(run, run);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private dispatch<T>(payload: Record<string, unknown>): Promise<T> {
    const child = this.ensureProcess();
    const id = this.nextId++;
    const timeoutMs =
      typeof payload.timeout_ms === "number" ? payload.timeout_ms : 120_000;
    const deadlineMs = timeoutMs + 15_000;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.terminate();
        reject(new Error(`执行器在 ${deadlineMs}ms 内没有响应请求 ${id}，已终止执行器进程`));
      }, deadlineMs);
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });
      try {
        child.stdin?.write(`${JSON.stringify({ ...payload, id })}\n`);
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(new Error(`执行器进程意外退出（写入请求失败: ${(err as Error).message}）`));
      }
    });
  }

  private ensureProcess(): ChildProcess {
    if (this.child) return this.child;
    const binary = executorBinaryPath();
    if (!existsSync(binary)) {
      throw new Error(`执行器不存在: ${binary}。先运行 npm run build 构建执行器。`);
    }
    const child = spawn(binary, [], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    this.child = child;
    this.lineBuffer = "";
    this.stderrTail = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => this.onStdout(chunk));
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-2000);
    });
    child.on("error", (err) => {
      if (this.child === child) this.child = null;
      this.failAll(`执行器启动失败: ${err.message}`);
    });
    child.on("exit", (code, signal) => {
      if (this.child === child) this.child = null;
      const why = code !== null ? `退出码 ${code}` : `信号 ${signal}`;
      const tail = this.stderrTail.trim();
      const detail = tail ? `执行器 stderr 末尾：${tail}` : "";
      this.failAll(`执行器进程意外退出（${why}）。${detail}`.trim());
    });
    return child;
  }

  private onStdout(chunk: string): void {
    this.lineBuffer += chunk;
    for (;;) {
      const nl = this.lineBuffer.indexOf("\n");
      if (nl < 0) break;
      const line = this.lineBuffer.slice(0, nl).trim();
      this.lineBuffer = this.lineBuffer.slice(nl + 1);
      if (!line) continue;
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      const id = parsed.id;
      const entry = typeof id === "number" ? this.pending.get(id) : undefined;
      if (!entry) continue;
      this.pending.delete(id as number);
      clearTimeout(entry.timer);
      entry.resolve(parsed);
    }
  }

  private failAll(message: string): void {
    for (const [id, entry] of [...this.pending]) {
      clearTimeout(entry.timer);
      this.pending.delete(id);
      entry.reject(new Error(message));
    }
  }

  private terminate(): void {
    const child = this.child;
    this.child = null;
    child?.kill();
  }
}

let shared: ExecutorClient | undefined;

/** 进程级共享一个执行器：无状态、常驻，进程退出时随 stdin 关闭自然结束 */
export function getExecutor(): ExecutorClient {
  shared ??= new ExecutorClient();
  return shared;
}

export interface ExecutorProbe {
  ok: boolean;
  detail?: string;
}

/** 状态灯用：临时起一个执行器进程发 ping，不动共享实例；2 秒内回不来算异常 */
export async function probeExecutorHandshake(): Promise<ExecutorProbe> {
  const binary = executorBinaryPath();
  if (!existsSync(binary)) {
    return { ok: false, detail: `执行器不存在: ${binary}。先运行 npm run build 构建执行器。` };
  }
  return new Promise((resolve) => {
    let child: ChildProcess | null = null;
    let settled = false;
    let buffer = "";
    let timer: NodeJS.Timeout | undefined;
    const finish = (result: ExecutorProbe): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      child?.kill();
      resolve(result);
    };
    timer = setTimeout(() => finish({ ok: false, detail: "执行器 2s 内没有响应 ping" }), 2_000);
    child = spawn(binary, [], { stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
    child.on("error", (err) => finish({ ok: false, detail: `执行器启动失败: ${err.message}` }));
    child.on("exit", (code) =>
      finish({ ok: false, detail: `执行器在响应 ping 前退出（exit ${code ?? "signal"}）` }),
    );
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      buffer += chunk;
      const nl = buffer.indexOf("\n");
      if (nl < 0) return;
      const line = buffer.slice(0, nl).trim();
      if (!line) return;
      try {
        const parsed = JSON.parse(line) as { id?: unknown; ok?: unknown; pong?: unknown };
        if (parsed.id === 1 && parsed.ok === true && parsed.pong === true) {
          finish({ ok: true });
        } else {
          finish({ ok: false, detail: "执行器 ping 响应格式不对" });
        }
      } catch {
        // 非 JSON 行不是本探测关心的内容，忽略
      }
    });
    child.stdin?.on("error", () => {});
    child.stdin?.write(`${JSON.stringify({ id: 1, op: "ping" })}\n`);
  });
}
