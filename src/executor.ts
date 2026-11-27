import { execFile, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { gitBashPath } from "./config.js";
import type { AppConfig } from "./config.js";
import { logDebug, logError } from "./log.js";
import { appRoot, isPackaged } from "./paths.js";

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
  /** 首行单行超过字节上限被截断时，该行末尾省略的字节数 */
  truncated_line_bytes?: number;
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
  /** 上下文行标记（context > 0 时出现） */
  is_context?: boolean;
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

export interface JobKillSuccess {
  ok: true;
  job_id: string;
  /** true 表示本次调用发出了终止；false 表示任务在调用前已经结束 */
  killed: boolean;
  /** 回执时刻的状态：killed=true 时为 running，退出靠后续 job_output 轮询 */
  status: "running" | "exited";
  /** 已结束任务的退出码；killed=true 时为 null */
  exit_code: number | null;
}

export type JobStartResponse = JobStartSuccess | ExecutorFailure;
export type JobOutputResponse = JobOutputSuccess | ExecutorFailure;
export type JobKillResponse = JobKillSuccess | ExecutorFailure;

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

/** 打包产物里执行器与 nexus-mcp.exe 同目录；开发态在 cargo 的 release 目录 */
function releaseBinaryPath(name: string): string {
  const suffix = process.platform === "win32" ? ".exe" : "";
  const dir = isPackaged ? appRoot : path.join(appRoot, "crates", "target", "release");
  return path.join(dir, `${name}${suffix}`);
}

/** 缺执行器时给两套人话：装好的用户该重装，写代码的人该先 build */
function missingExecutorMessage(binary: string): string {
  return isPackaged
    ? `执行器不存在: ${binary}。执行器应和 nexus-mcp.exe 在同一目录，重新运行安装包即可修复。`
    : `执行器不存在: ${binary}。先运行 npm run build 构建执行器。`;
}

/** shell 配置 → 具体执行程序。powershell(5.1) 在 loadConfig 启动校验时就被拒绝 */
export function resolveShell(config: AppConfig): ShellSpec {
  if (config.shell === "pwsh") return { kind: "pwsh", program: "pwsh" };
  // 打包版里 auto 可能在缺 Git Bash 的机器上降级放行，真要用 shell 时才在这里报错
  const bash = gitBashPath();
  if (!existsSync(bash)) {
    throw new Error(
      `找不到 Git Bash（${bash}），这条工具需要命令执行。装一个 Git for Windows 即可，` +
        "或在 config.json 里把 shell 改成 pwsh；read/write/edit/glob/grep 不需要它。",
    );
  }
  return { kind: "git-bash", program: bash };
}

interface Pending {
  op: string;
  startedAt: number;
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

/** 执行器协议客户端：单行 JSON over stdio，按自增 id 多路复用并发请求 */
export class ExecutorClient {
  private child: ChildProcess | null = null;
  private lineBuffer = "";
  private stderrTail = "";
  private pending = new Map<number, Pending>();
  private nextId = 1;

  /** 按自增 id 直接派发，响应由 pending 表按 id 路由，避免慢请求阻塞其他工具 */
  request<T>(
    payload: Record<string, unknown>,
    options?: { deadlineMs?: number },
  ): Promise<T> {
    const child = this.ensureProcess();
    const id = this.nextId++;
    const op = typeof payload.op === "string" ? payload.op : "unknown";
    const startedAt = Date.now();
    const timeoutMs =
      typeof payload.timeout_ms === "number" ? payload.timeout_ms : 120_000;
    const deadlineMs = options?.deadlineMs ?? timeoutMs + 15_000;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        logError("ipc.timeout", { id, op, timeout_ms: deadlineMs });
        reject(new Error(`执行器在 ${deadlineMs}ms 内没有响应请求 ${id}`));
      }, deadlineMs);
      this.pending.set(id, {
        op,
        startedAt,
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });
      try {
        child.stdin?.write(`${JSON.stringify({ ...payload, id })}\n`);
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        logError("ipc.write_error", { id, op, err: (err as Error).message });
        reject(new Error(`执行器进程意外退出（写入请求失败: ${(err as Error).message}）`));
      }
    });
  }

  private ensureProcess(): ChildProcess {
    if (this.child) return this.child;
    const binary = executorBinaryPath();
    if (!existsSync(binary)) {
      throw new Error(missingExecutorMessage(binary));
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
      const unexpected = this.child === child;
      if (unexpected) {
        this.child = null;
        logError("executor.error", { err: err.message });
      }
      this.failAll(`执行器启动失败: ${err.message}`);
    });
    child.on("exit", (code, signal) => {
      const unexpected = this.child === child;
      if (unexpected) {
        this.child = null;
        logError("executor.exit", { code: code ?? "-", signal: signal ?? "-" });
      }
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
      logDebug("ipc.done", {
        id: id as number,
        op: entry.op,
        ms: Date.now() - entry.startedAt,
        ok: parsed.ok === true,
      });
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

  /**
   * 关闭执行器并树杀其持有的全部后台任务：
   * 先关 stdin 让执行器主循环走优雅退出（调 kill_all_running），
   * 超时未退（如正阻塞在同步 bash）则用 taskkill /T /F + kill 强行收尾。
   */
  async close(): Promise<void> {
    const child = this.child;
    this.child = null;
    this.lineBuffer = "";
    this.stderrTail = "";
    this.failAll("MCP 服务已停止，执行器已关闭");
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      return;
    }

    const waitForExit = (timeoutMs: number): Promise<boolean> =>
      new Promise((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) {
          resolve(true);
          return;
        }
        const timer = setTimeout(() => {
          child.off("exit", onExit);
          resolve(false);
        }, timeoutMs);
        const onExit = (): void => {
          clearTimeout(timer);
          resolve(true);
        };
        child.once("exit", onExit);
      });

    try {
      child.stdin?.end();
    } catch {
      // ignore broken pipe
    }
    if (await waitForExit(500)) return;

    if (process.platform === "win32" && typeof child.pid === "number") {
      await new Promise<void>((resolve) => {
        execFile(
          "taskkill",
          ["/PID", String(child.pid), "/T", "/F"],
          { windowsHide: true },
          () => resolve(),
        );
      });
    }
    try {
      child.kill();
    } catch {
      // ignore
    }
    await waitForExit(2_000);
  }
}

let shared: ExecutorClient | undefined;

/** 进程级共享一个执行器：无状态、常驻，服务停止/重启时经 closeExecutor 显式关闭 */
export function getExecutor(): ExecutorClient {
  shared ??= new ExecutorClient();
  return shared;
}

/** 关闭当前共享执行器实例（下次调用 getExecutor 时按需拉起新实例） */
export async function closeExecutor(): Promise<void> {
  const current = shared;
  shared = undefined;
  if (current) {
    await current.close();
  }
}

export interface ExecutorProbe {
  ok: boolean;
  detail?: string;
}

/** 状态灯用：临时起一个执行器进程发 ping，不动共享实例；2 秒内回不来算异常 */
export async function probeExecutorHandshake(): Promise<ExecutorProbe> {
  const binary = executorBinaryPath();
  if (!existsSync(binary)) {
    return { ok: false, detail: missingExecutorMessage(binary) };
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
