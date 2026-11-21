import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppConfig } from "./config.js";
import { displayPath, resolveInRoot } from "./config.js";

type TextResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

function ok(text: string): TextResult {
  return { content: [{ type: "text", text }] };
}

function fail(message: string): TextResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

function stub(name: string, detail: string): TextResult {
  return ok(`[stub] ${name} 已注册，执行层尚未接入。\n${detail}`);
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
        return stub(
          "read",
          `目标: ${displayPath(config.root, abs)}  offset=${offset ?? 1} limit=${limit ?? "全部"}`,
        );
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
        return stub(
          "write",
          `目标: ${displayPath(config.root, abs)}  写入 ${Buffer.byteLength(content, "utf8")} 字节`,
        );
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
        return stub(
          "edit",
          `目标: ${displayPath(config.root, abs)}  替换 ${old_string.length} → ${new_string.length} 字符，replace_all=${replace_all ?? false}`,
        );
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
        return stub(
          "bash",
          `cwd: ${displayPath(config.root, dir)}  命令: ${command}  超时: ${timeout_ms ?? config.defaultTimeoutMs}ms`,
        );
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
        return stub("glob", `pattern: ${pattern}  起点: ${displayPath(config.root, dir)}`);
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
        return stub(
          "grep",
          `pattern: ${pattern}  起点: ${displayPath(config.root, dir)}  glob=${glob ?? "*"}  忽略大小写=${ignore_case ?? false}`,
        );
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
        return stub("job_start", `cwd: ${displayPath(config.root, dir)}  命令: ${command}`);
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
      return stub("job_output", `job_id: ${job_id}  offset: ${offset ?? 0}`);
    },
  );
}
