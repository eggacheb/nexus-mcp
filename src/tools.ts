import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppConfig } from "./config.js";
import { getExecutor, resolveShell } from "./executor.js";
import { logDebug, logEvent, logWarn, summarizeText } from "./log.js";
import type { LogFieldValue, LogLevel } from "./log.js";
import {
  displayPath,
  resolveOptionalDir,
  resolveRequiredFileTarget,
} from "./sandboxPath.js";
import type {
  BashResponse,
  EditResponse,
  GlobResponse,
  GrepResponse,
  JobKillResponse,
  JobOutputResponse,
  JobStartResponse,
  ReadResponse,
  WriteResponse,
} from "./executor.js";

/** read 未传 limit 时的默认行数，与工具 schema 的 limit 上限一致 */
const MAX_READ_LINES = 2000;
/** glob/grep 单次返回条数上限；工具 schema 没有 limit 参数，上限在协议层固定 */
const MAX_SEARCH_RESULTS = 100;
/**
 * grep 的协议超时：rg 不在 PATH 时执行器会现场下载 pinned 版本（分钟级），
 * 搜索本身毫秒级，预算全部留给下载兜底。
 */
const GREP_TIMEOUT_MS = 300_000;
/** glob/grep 的 pattern 日志截断上限 */
const MAX_PATTERN_LOG_CHARS = 80;
/** bash/job_start 的命令日志截断上限 */
const MAX_CMD_LOG_CHARS = 120;
/** 错误原因摘要截断上限 */
const MAX_ERR_LOG_CHARS = 160;
/** 标准 MCP 只读工具注解，帮助云端连接器识别无副作用查询 */
const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

export interface RegisterToolsOptions {
  /** HTTP 传输下返回当前会话 id；stdio 下省略，日志记为 stdio */
  sessionId?: () => string | undefined;
  /** 对外公网地址（隧道地址优先），用于拼 serverInfo.icons 的可访问 URL */
  baseUrl?: string;
}

/**
 * 面板「可用工具」卡用的短说明。名称必须与下面 registerTools 注册的一一对应，
 * tests/panel.test.ts 会拿它跟 MCP 客户端列出来的清单比对，防止两处漂移。
 */
export const TOOL_SUMMARY: ReadonlyArray<{ name: string; summary: string }> = [
  { name: "read", summary: "读文件，支持行范围" },
  { name: "write", summary: "覆盖写文件，自动建父目录" },
  { name: "edit", summary: "按上下文替换文件片段" },
  { name: "bash", summary: "在沙箱里跑命令" },
  { name: "glob", summary: "按通配符找文件" },
  { name: "grep", summary: "按正则搜内容" },
  { name: "job_start", summary: "起后台长任务" },
  { name: "job_output", summary: "读后台任务输出" },
  { name: "job_kill", summary: "结束后台任务" },
];

type TextResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

interface ToolExtra {
  sessionId?: string;
}

function ok(text: string): TextResult {
  return { content: [{ type: "text", text }] };
}

function fail(message: string): TextResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

function shortSid(extra: ToolExtra | undefined, options: RegisterToolsOptions | undefined): string {
  const raw = extra?.sessionId ?? options?.sessionId?.();
  return raw ? raw.slice(0, 8) : "stdio";
}

function safeDisplayFile(root: string, filePath: string, secret: string): string {
  try {
    const target = resolveRequiredFileTarget(root, filePath);
    return displayPath(root, target.path);
  } catch {
    return summarizeText(filePath, MAX_PATTERN_LOG_CHARS, secret);
  }
}

function safeDisplayDir(root: string, dirInput: string | undefined, secret: string): string {
  try {
    return displayPath(root, resolveOptionalDir(root, dirInput));
  } catch {
    return summarizeText(dirInput ?? ".", MAX_PATTERN_LOG_CHARS, secret);
  }
}

export function registerTools(
  server: McpServer,
  config: AppConfig,
  options?: RegisterToolsOptions,
): void {
  function beginTool(
    tool: string,
    extra: ToolExtra | undefined,
    targetFields: Record<string, LogFieldValue>,
  ) {
    const sid = shortSid(extra, options);
    const startedAt = Date.now();
    logDebug("tool.start", { sid, tool, ...targetFields });
    return {
      ok(text: string, resultFields?: Record<string, LogFieldValue>, level: LogLevel = "info"): TextResult {
        logEvent(level, "tool.ok", {
          sid,
          tool,
          ...targetFields,
          ...resultFields,
          ms: Date.now() - startedAt,
        });
        return ok(text);
      },
      fail(message: string, resultFields?: Record<string, LogFieldValue>): TextResult {
        logWarn("tool.err", {
          sid,
          tool,
          ...targetFields,
          ...resultFields,
          ms: Date.now() - startedAt,
          err: summarizeText(message, MAX_ERR_LOG_CHARS, config.token),
        });
        return fail(message);
      },
    };
  }

  server.registerTool(
    "read",
    {
      title: "Read file",
      description:
        "读取文本文件，返回带行号的内容。用 offset/limit 读取片段，避免一次拉太长。",
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: {
        path: z.string().describe("文件路径，绝对路径或相对根目录"),
        offset: z
          .number()
          .int()
          .refine((n) => n !== 0, "offset 不能为 0")
          .optional()
          .describe("起始行号（正数从 1 开始；负数从文件末尾倒数，如 -50 读最后 50 行）"),
        limit: z.number().int().min(1).max(2000).optional().describe("最多读取多少行"),
      },
    },
    async ({ path: filePath, offset, limit }, extra) => {
      const trace = beginTool("read", extra, {
        path: safeDisplayFile(config.root, filePath, config.token),
        offset,
        limit,
      });
      try {
        const target = resolveRequiredFileTarget(config.root, filePath);
        const response = await getExecutor().request<ReadResponse>({
          op: "read",
          ...target,
          offset: offset ?? 1,
          limit: limit ?? MAX_READ_LINES,
          max_output_bytes: config.maxOutputBytes,
        });
        if (!response.ok) return trace.fail(response.error);
        if (response.total_lines === 0) {
          return trace.ok("（空文件，共 0 行）", { lines: "0/0" });
        }
        if (response.end_line === 0) {
          return trace.ok(
            `文件共 ${response.total_lines} 行，offset=${offset ?? 1} 超出文件末尾，没有内容可读`,
            { lines: `0/${response.total_lines}` },
          );
        }
        let text = response.content;
        const singleLineTruncated = (response.truncated_line_bytes ?? 0) > 0;
        if (singleLineTruncated) {
          text += `\n[第 ${response.start_line} 行单行超过字节上限，行尾已省略 ${response.truncated_line_bytes} 字节]`;
        }
        if (response.end_line < response.total_lines) {
          text += `\n[已显示 ${response.start_line}-${response.end_line} 行，文件共 ${response.total_lines} 行；用 offset=${response.end_line + 1} 继续读取]`;
        }
        if (response.omitted_lines > 0 && !singleLineTruncated) {
          text += `\n[输出超过字节上限，还有 ${response.omitted_lines} 行未显示；用 limit 缩小范围分次读取]`;
        }
        return trace.ok(text, {
          lines: `${response.start_line}-${response.end_line}/${response.total_lines}`,
        });
      } catch (err) {
        return trace.fail((err as Error).message);
      }
    },
  );

  server.registerTool(
    "write",
    {
      title: "Write file",
      description: "把内容整体写入文件，覆盖原文件（沙箱内缺失的父目录会自动创建）。需要局部修改请用 edit。",
      inputSchema: {
        path: z.string().describe("文件路径，绝对路径或相对根目录"),
        content: z.string().describe("完整文件内容"),
      },
    },
    async ({ path: filePath, content }, extra) => {
      const trace = beginTool("write", extra, {
        path: safeDisplayFile(config.root, filePath, config.token),
        bytes: Buffer.byteLength(content, "utf8"),
      });
      try {
        const target = resolveRequiredFileTarget(config.root, filePath);
        const response = await getExecutor().request<WriteResponse>({
          op: "write",
          ...target,
          content,
        });
        if (!response.ok) return trace.fail(response.error);
        return trace.ok(
          `已写入 ${displayPath(config.root, target.path)}（${response.bytes_written} 字节）`,
          { bytes: response.bytes_written },
        );
      } catch (err) {
        return trace.fail((err as Error).message);
      }
    },
  );

  server.registerTool(
    "edit",
    {
      title: "Edit file",
      description:
        "在文件中把 old_string 替换成 new_string。old_string 必须在文件里唯一出现，否则失败。这是修改代码的默认方式。",
      inputSchema: {
        path: z.string().describe("文件路径"),
        old_string: z.string().describe("要被替换的原文，必须唯一"),
        new_string: z.string().describe("替换后的内容"),
        replace_all: z.boolean().optional().describe("为 true 时替换所有匹配"),
      },
    },
    async ({ path: filePath, old_string, new_string, replace_all }, extra) => {
      const trace = beginTool("edit", extra, {
        path: safeDisplayFile(config.root, filePath, config.token),
        old_len: old_string.length,
        new_len: new_string.length,
      });
      try {
        const target = resolveRequiredFileTarget(config.root, filePath);
        const response = await getExecutor().request<EditResponse>({
          op: "edit",
          ...target,
          old_string,
          new_string,
          replace_all: replace_all ?? false,
        });
        if (!response.ok) return trace.fail(response.error);
        const where =
          response.start_line === response.end_line
            ? `第 ${response.start_line} 行`
            : `第 ${response.start_line}-${response.end_line} 行`;
        const detail =
          response.replacements === 1
            ? where
            : `替换 ${response.replacements} 处，首处${where}`;
        return trace.ok(`已编辑 ${displayPath(config.root, target.path)}（${detail}）`, {
          replacements: response.replacements,
          lines: `${response.start_line}-${response.end_line}`,
        });
      } catch (err) {
        return trace.fail((err as Error).message);
      }
    },
  );

  server.registerTool(
    "bash",
    {
      title: "Run command",
      description:
        "在工作目录执行命令并返回输出与退出码。默认 120 秒超时；跑构建、测试这类长任务请用 job_start。",
      inputSchema: {
        command: z.string().describe("要执行的命令"),
        cwd: z.string().optional().describe("工作目录，默认根目录"),
        timeout_ms: z.number().int().min(1000).max(600_000).optional().describe("超时毫秒"),
      },
    },
    async ({ command, cwd, timeout_ms }, extra) => {
      const trace = beginTool("bash", extra, {
        cwd: safeDisplayDir(config.root, cwd, config.token),
        cmd: summarizeText(command, MAX_CMD_LOG_CHARS, config.token),
      });
      try {
        const dir = resolveOptionalDir(config.root, cwd);
        const timeout = timeout_ms ?? config.defaultTimeoutMs;
        const response = await getExecutor().request<BashResponse>({
          op: "bash",
          command,
          root: config.root,
          cwd: dir,
          timeout_ms: timeout,
          max_output_bytes: config.maxOutputBytes,
          shell: resolveShell(config),
          policy: config.commandPolicy,
        });
        if (!response.ok) return trace.fail(response.error);
        const body = response.output ? `\n\n${response.output}` : "";
        if (response.timed_out) {
          return trace.ok(`timed_out: ${timeout}ms（命令已终止）${body}`, { timed_out: true });
        }
        return trace.ok(`exit_code: ${response.exit_code}${body}`, { exit: response.exit_code });
      } catch (err) {
        return trace.fail((err as Error).message);
      }
    },
  );

  server.registerTool(
    "glob",
    {
      title: "Find files",
      description: "按通配符查找文件路径，遵循 .gitignore，返回按修改时间倒序的列表。",
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: {
        pattern: z.string().describe("通配符，例如 **/*.ts"),
        path: z.string().optional().describe("搜索起点，默认根目录"),
      },
    },
    async ({ pattern, path: searchPath }, extra) => {
      const trace = beginTool("glob", extra, {
        path: safeDisplayDir(config.root, searchPath, config.token),
        pattern: summarizeText(pattern, MAX_PATTERN_LOG_CHARS, config.token),
      });
      try {
        const dir = resolveOptionalDir(config.root, searchPath);
        const response = await getExecutor().request<GlobResponse>({
          op: "glob",
          root: config.root,
          path: dir,
          pattern,
          max_results: MAX_SEARCH_RESULTS,
        });
        if (!response.ok) return trace.fail(response.error);
        if (response.paths.length === 0) {
          return trace.ok(`没有匹配「${pattern}」的文件（已遵守 .gitignore）。`, { matches: 0 });
        }
        let text = response.paths.join("\n");
        if (response.truncated) {
          text += `\n\n共 ${response.total_matches} 个匹配，按修改时间从新到旧显示前 ${response.paths.length} 个，还有更多未显示；用更具体的 pattern 或指定 path 缩小搜索范围。`;
        } else {
          text += `\n\n共 ${response.total_matches} 个匹配。`;
        }
        return trace.ok(text, {
          matches: response.total_matches,
          truncated: response.truncated ? true : undefined,
        });
      } catch (err) {
        return trace.fail((err as Error).message);
      }
    },
  );

  server.registerTool(
    "grep",
    {
      title: "Search content",
      description: "在文件内容里搜索正则，返回匹配的文件与行号。底层调用 ripgrep。",
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: {
        pattern: z.string().describe("正则表达式"),
        path: z.string().optional().describe("搜索起点（目录或单文件），默认根目录"),
        glob: z.string().optional().describe("限定文件范围，例如 *.ts"),
        ignore_case: z.boolean().optional().describe("是否忽略大小写"),
      },
    },
    async ({ pattern, path: searchPath, glob, ignore_case }, extra) => {
      const trace = beginTool("grep", extra, {
        path: safeDisplayDir(config.root, searchPath, config.token),
        pattern: summarizeText(pattern, MAX_PATTERN_LOG_CHARS, config.token),
        glob: glob ? summarizeText(glob, 40, config.token) : undefined,
      });
      try {
        const dir = resolveOptionalDir(config.root, searchPath);
        const response = await getExecutor().request<GrepResponse>({
          op: "grep",
          root: config.root,
          path: dir,
          pattern,
          glob,
          ignore_case: ignore_case ?? false,
          max_results: MAX_SEARCH_RESULTS,
          timeout_ms: GREP_TIMEOUT_MS,
        });
        if (!response.ok) return trace.fail(response.error);
        if (response.matches.length === 0) {
          return trace.ok(
            `没有匹配「${pattern}」的内容（已遵守 .gitignore；可尝试 ignore_case 或放宽 pattern）。`,
            { matches: 0 },
          );
        }
        let body = response.matches.map((m) => `${m.path}:${m.line}: ${m.text}`).join("\n");
        if (response.truncated) {
          body += `\n\n已显示前 ${response.matches.length} 条匹配，还有更多未显示；用 glob 参数限定文件类型、指定 path 缩小搜索范围，或换更精确的 pattern。`;
        }
        return trace.ok(body, {
          matches: response.matches.length,
          truncated: response.truncated ? true : undefined,
        });
      } catch (err) {
        return trace.fail((err as Error).message);
      }
    },
  );

  server.registerTool(
    "job_start",
    {
      title: "Start background job",
      description:
        "在后台启动长任务（构建、测试、监听），立刻返回 job_id。用 job_output 查看进度。",
      inputSchema: {
        command: z.string().describe("要执行的命令"),
        cwd: z.string().optional().describe("工作目录，默认根目录"),
      },
    },
    async ({ command, cwd }, extra) => {
      const trace = beginTool("job_start", extra, {
        cwd: safeDisplayDir(config.root, cwd, config.token),
        cmd: summarizeText(command, MAX_CMD_LOG_CHARS, config.token),
      });
      try {
        const dir = resolveOptionalDir(config.root, cwd);
        const response = await getExecutor().request<JobStartResponse>({
          op: "job_start",
          command,
          root: config.root,
          cwd: dir,
          max_output_bytes: config.maxOutputBytes,
          shell: resolveShell(config),
          policy: config.commandPolicy,
        });
        if (!response.ok) return trace.fail(response.error);
        return trace.ok(
          `已启动后台任务 ${response.job_id}（pid ${response.pid}）。用 job_output 查看输出与状态。`,
          { job_id: response.job_id, pid: response.pid },
        );
      } catch (err) {
        return trace.fail((err as Error).message);
      }
    },
  );

  server.registerTool(
    "job_output",
    {
      title: "Read job output",
      description:
        "读取后台任务的增量输出与退出状态。任务结束后保留结果供反复查看；传 wait_ms 可短等待任务退出或新输出。",
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: {
        job_id: z.string().describe("job_start 返回的 id"),
        offset: z.number().int().min(0).optional().describe("从第几个字节开始读"),
        wait_ms: z
          .number()
          .int()
          .min(0)
          .max(30_000)
          .optional()
          .describe("可选短等待毫秒数（0-30000，默认 0 立即返回；任务退出或有新输出时提前返回）"),
      },
    },
    async ({ job_id, offset, wait_ms }, extra) => {
      const effectiveWait = wait_ms ?? 0;
      const trace = beginTool("job_output", extra, {
        job_id,
        offset: offset ?? 0,
        wait_ms: effectiveWait > 0 ? effectiveWait : undefined,
      });
      try {
        const response = await getExecutor().request<JobOutputResponse>(
          {
            op: "job_output",
            job_id,
            offset: offset ?? 0,
            wait_ms: effectiveWait,
            max_output_bytes: config.maxOutputBytes,
          },
          { deadlineMs: Math.max(120_000, effectiveWait + 15_000) },
        );
        if (!response.ok) return trace.fail(response.error);
        const head = [`status: ${response.status}`];
        if (response.exit_code !== null) head.push(`exit_code: ${response.exit_code}`);
        let body = response.output;
        if (body === "" && response.status === "running") body = "（暂无新输出）";
        let text = `${head.join("\n")}\n\n${body}`;
        if (response.status === "running" || response.next_offset < response.total_bytes) {
          text += `\n\n[下次调用用 offset=${response.next_offset} 继续读取]`;
        }
        const outputBytes = Buffer.byteLength(response.output, "utf8");
        const isEmptyPoll = response.status === "running" && outputBytes === 0;
        return trace.ok(
          text,
          {
            status: response.status,
            bytes: outputBytes,
            exit: response.exit_code ?? undefined,
          },
          isEmptyPoll ? "debug" : "info",
        );
      } catch (err) {
        return trace.fail((err as Error).message);
      }
    },
  );

  server.registerTool(
    "job_kill",
    {
      title: "Kill background job",
      description:
        "终止后台任务（连同它派生的子进程），立刻返回回执，用 job_output 确认退出。",
      inputSchema: {
        job_id: z.string().describe("job_start 返回的 id"),
      },
    },
    async ({ job_id }, extra) => {
      const trace = beginTool("job_kill", extra, { job_id });
      try {
        const response = await getExecutor().request<JobKillResponse>({
          op: "job_kill",
          job_id,
        });
        if (!response.ok) return trace.fail(response.error);
        const head = [`killed: ${response.killed}`, `status: ${response.status}`];
        if (response.exit_code !== null) head.push(`exit_code: ${response.exit_code}`);
        const note = response.killed
          ? `已终止 ${response.job_id} 的进程树。用 job_output 确认退出码。`
          : `${response.job_id} 已经结束（exit_code: ${response.exit_code}），无需终止。`;
        return trace.ok(`${head.join("\n")}\n\n${note}`, {
          killed: response.killed,
          status: response.status,
        });
      } catch (err) {
        return trace.fail((err as Error).message);
      }
    },
  );
}
