import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppConfig } from "./config.js";
import { displayPath, resolveInRoot } from "./config.js";
import { getExecutor, resolveShell } from "./executor.js";
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

type TextResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

function ok(text: string): TextResult {
  return { content: [{ type: "text", text }] };
}

function fail(message: string): TextResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

export function registerTools(server: McpServer, config: AppConfig): void {
  server.registerTool(
    "read",
    {
      title: "Read file",
      description:
        "读取文本文件，返回带行号的内容。用 offset/limit 读取片段，避免一次拉太长。",
      inputSchema: {
        path: z.string().describe("文件路径，绝对路径或相对根目录"),
        offset: z.number().int().min(1).optional().describe("起始行号，从 1 开始"),
        limit: z.number().int().min(1).max(2000).optional().describe("最多读取多少行"),
      },
    },
    async ({ path: filePath, offset, limit }) => {
      try {
        const abs = resolveInRoot(config.root, filePath);
        const response = await getExecutor().request<ReadResponse>({
          op: "read",
          path: abs,
          root: config.root,
          offset: offset ?? 1,
          limit: limit ?? MAX_READ_LINES,
          max_output_bytes: config.maxOutputBytes,
        });
        if (!response.ok) return fail(response.error);
        if (response.total_lines === 0) return ok("（空文件，共 0 行）");
        if (response.end_line === 0) {
          return ok(
            `文件共 ${response.total_lines} 行，offset=${offset ?? 1} 超出文件末尾，没有内容可读`,
          );
        }
        let text = response.content;
        if (response.end_line < response.total_lines) {
          text += `\n[已显示 ${response.start_line}-${response.end_line} 行，文件共 ${response.total_lines} 行；用 offset=${response.end_line + 1} 继续读取]`;
        }
        if (response.omitted_lines > 0) {
          text += `\n[输出超过字节上限，还有 ${response.omitted_lines} 行未显示；用 limit 缩小范围分次读取]`;
        }
        return ok(text);
      } catch (err) {
        return fail((err as Error).message);
      }
    },
  );

  server.registerTool(
    "write",
    {
      title: "Write file",
      description: "把内容整体写入文件，覆盖原文件。需要局部修改请用 edit。",
      inputSchema: {
        path: z.string().describe("文件路径，绝对路径或相对根目录"),
        content: z.string().describe("完整文件内容"),
      },
    },
    async ({ path: filePath, content }) => {
      try {
        const abs = resolveInRoot(config.root, filePath);
        const response = await getExecutor().request<WriteResponse>({
          op: "write",
          path: abs,
          root: config.root,
          content,
        });
        if (!response.ok) return fail(response.error);
        return ok(`已写入 ${displayPath(config.root, abs)}（${response.bytes_written} 字节）`);
      } catch (err) {
        return fail((err as Error).message);
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
    async ({ path: filePath, old_string, new_string, replace_all }) => {
      try {
        const abs = resolveInRoot(config.root, filePath);
        const response = await getExecutor().request<EditResponse>({
          op: "edit",
          path: abs,
          root: config.root,
          old_string,
          new_string,
          replace_all: replace_all ?? false,
        });
        if (!response.ok) return fail(response.error);
        const where =
          response.start_line === response.end_line
            ? `第 ${response.start_line} 行`
            : `第 ${response.start_line}-${response.end_line} 行`;
        const detail =
          response.replacements === 1
            ? where
            : `替换 ${response.replacements} 处，首处${where}`;
        return ok(`已编辑 ${displayPath(config.root, abs)}（${detail}）`);
      } catch (err) {
        return fail((err as Error).message);
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
    async ({ command, cwd, timeout_ms }) => {
      try {
        const dir = cwd ? resolveInRoot(config.root, cwd) : config.root;
        const timeout = timeout_ms ?? config.defaultTimeoutMs;
        const response = await getExecutor().request<BashResponse>({
          op: "bash",
          command,
          cwd: dir,
          timeout_ms: timeout,
          max_output_bytes: config.maxOutputBytes,
          shell: resolveShell(config),
          policy: config.commandPolicy,
        });
        if (!response.ok) return fail(response.error);
        const body = response.output ? `\n\n${response.output}` : "";
        if (response.timed_out) {
          return ok(`timed_out: ${timeout}ms（命令已终止）${body}`);
        }
        return ok(`exit_code: ${response.exit_code}${body}`);
      } catch (err) {
        return fail((err as Error).message);
      }
    },
  );

  server.registerTool(
    "glob",
    {
      title: "Find files",
      description: "按通配符查找文件路径，遵循 .gitignore，返回按修改时间倒序的列表。",
      inputSchema: {
        pattern: z.string().describe("通配符，例如 **/*.ts"),
        path: z.string().optional().describe("搜索起点，默认根目录"),
      },
    },
    async ({ pattern, path: searchPath }) => {
      try {
        const dir = searchPath ? resolveInRoot(config.root, searchPath) : config.root;
        const response = await getExecutor().request<GlobResponse>({
          op: "glob",
          root: config.root,
          path: dir,
          pattern,
          max_results: MAX_SEARCH_RESULTS,
        });
        if (!response.ok) return fail(response.error);
        if (response.paths.length === 0) {
          return ok(`没有匹配「${pattern}」的文件（已遵守 .gitignore）。`);
        }
        let text = response.paths.join("\n");
        if (response.truncated) {
          text += `\n\n共 ${response.total_matches} 个匹配，按修改时间从新到旧显示前 ${response.paths.length} 个，还有更多未显示；用更具体的 pattern 或指定 path 缩小搜索范围。`;
        } else {
          text += `\n\n共 ${response.total_matches} 个匹配。`;
        }
        return ok(text);
      } catch (err) {
        return fail((err as Error).message);
      }
    },
  );

  server.registerTool(
    "grep",
    {
      title: "Search content",
      description: "在文件内容里搜索正则，返回匹配的文件与行号。底层调用 ripgrep。",
      inputSchema: {
        pattern: z.string().describe("正则表达式"),
        path: z.string().optional().describe("搜索起点，默认根目录"),
        glob: z.string().optional().describe("限定文件范围，例如 *.ts"),
        ignore_case: z.boolean().optional().describe("是否忽略大小写"),
      },
    },
    async ({ pattern, path: searchPath, glob, ignore_case }) => {
      try {
        const dir = searchPath ? resolveInRoot(config.root, searchPath) : config.root;
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
        if (!response.ok) return fail(response.error);
        if (response.matches.length === 0) {
          return ok(
            `没有匹配「${pattern}」的内容（已遵守 .gitignore；可尝试 ignore_case 或放宽 pattern）。`,
          );
        }
        let body = response.matches.map((m) => `${m.path}:${m.line}: ${m.text}`).join("\n");
        if (response.truncated) {
          body += `\n\n已显示前 ${response.matches.length} 条匹配，还有更多未显示；用 glob 参数限定文件类型、指定 path 缩小搜索范围，或换更精确的 pattern。`;
        }
        return ok(body);
      } catch (err) {
        return fail((err as Error).message);
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
    async ({ command, cwd }) => {
      try {
        const dir = cwd ? resolveInRoot(config.root, cwd) : config.root;
        const response = await getExecutor().request<JobStartResponse>({
          op: "job_start",
          command,
          cwd: dir,
          max_output_bytes: config.maxOutputBytes,
          shell: resolveShell(config),
          policy: config.commandPolicy,
        });
        if (!response.ok) return fail(response.error);
        return ok(
          `已启动后台任务 ${response.job_id}（pid ${response.pid}）。用 job_output 查看输出与状态。`,
        );
      } catch (err) {
        return fail((err as Error).message);
      }
    },
  );

  server.registerTool(
    "job_output",
    {
      title: "Read job output",
      description: "读取后台任务的增量输出与退出状态。任务结束后保留结果供反复查看。",
      inputSchema: {
        job_id: z.string().describe("job_start 返回的 id"),
        offset: z.number().int().min(0).optional().describe("从第几个字节开始读"),
      },
    },
    async ({ job_id, offset }) => {
      try {
        const response = await getExecutor().request<JobOutputResponse>({
          op: "job_output",
          job_id,
          offset: offset ?? 0,
          max_output_bytes: config.maxOutputBytes,
        });
        if (!response.ok) return fail(response.error);
        const head = [`status: ${response.status}`];
        if (response.exit_code !== null) head.push(`exit_code: ${response.exit_code}`);
        let body = response.output;
        if (body === "" && response.status === "running") body = "（暂无新输出）";
        let text = `${head.join("\n")}\n\n${body}`;
        if (response.status === "running" || response.next_offset < response.total_bytes) {
          text += `\n\n[下次调用用 offset=${response.next_offset} 继续读取]`;
        }
        return ok(text);
      } catch (err) {
        return fail((err as Error).message);
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
    async ({ job_id }) => {
      try {
        const response = await getExecutor().request<JobKillResponse>({
          op: "job_kill",
          job_id,
        });
        if (!response.ok) return fail(response.error);
        const head = [`killed: ${response.killed}`, `status: ${response.status}`];
        if (response.exit_code !== null) head.push(`exit_code: ${response.exit_code}`);
        const note = response.killed
          ? `已终止 ${response.job_id} 的进程树。用 job_output 确认退出码。`
          : `${response.job_id} 已经结束（exit_code: ${response.exit_code}），无需终止。`;
        return ok(`${head.join("\n")}\n\n${note}`);
      } catch (err) {
        return fail((err as Error).message);
      }
    },
  );
}
