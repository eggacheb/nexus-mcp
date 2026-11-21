import { expectOk } from "./support/tool.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { projectRoot } from "./support/server.js";

interface ToolResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

function textOf(result: ToolResult): string {
  return result.content[0]?.text ?? "";
}

interface StdioSession {
  client: Client;
  close(): Promise<void>;
}

/** 起一个 stdio 模式的真实 dist 进程 */
async function connectStdio(env: Record<string, string> = {}): Promise<StdioSession> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(projectRoot, "dist", "index.js"), "--stdio"],
    cwd: projectRoot,
    env: { ...process.env, ...env } as Record<string, string>,
    stderr: "ignore",
  });
  const client = new Client({ name: "vitest-jobs", version: "0.1.0" });
  await client.connect(transport);
  return {
    client,
    async close() {
      await client.close();
    },
  };
}

async function callTool(client: Client, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  return (await client.callTool({ name, arguments: args })) as ToolResult;
}

interface TempConfig {
  path: string;
  dir: string;
}

function writeTempConfig(overrides: Record<string, unknown> = {}): TempConfig {
  const dir = mkdtempSync(path.join(os.tmpdir(), "nexus-mcp-jobs-cfg-"));
  const configPath = path.join(dir, "config.json");
  writeFileSync(
    configPath,
    JSON.stringify({ root: projectRoot, transport: "stdio", ...overrides }, null, 2),
    "utf8",
  );
  return { path: configPath, dir };
}

async function waitFor(
  condition: () => Promise<boolean>,
  timeoutMs: number,
  intervalMs = 150,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`条件在 ${timeoutMs}ms 内未满足`);
}

/** job_output 文本里的 status 行 */
function statusOf(text: string): string {
  const match = text.match(/^status: (\S+)$/m);
  if (!match) throw new Error(`job_output 响应缺少 status 行: ${text}`);
  return match[1] ?? "";
}

/** job_output 文本里的 exit_code 行；运行中不存在 */
function exitCodeOf(text: string): number | null {
  const match = text.match(/^exit_code: (-?\d+)$/m);
  return match ? Number(match[1]) : null;
}

/** 尾注里提示的下次读取偏移 */
function nextOffsetOf(text: string): number {
  const match = text.match(/offset=(\d+)/);
  if (!match) throw new Error(`job_output 响应缺少继续读取提示: ${text}`);
  return Number(match[1]);
}

/** status 头之后的输出正文（去掉继续读取提示） */
function bodyOf(text: string): string {
  const start = text.indexOf("\n\n");
  if (start < 0) return "";
  let body = text.slice(start + 2);
  const hint = body.indexOf("\n\n[下次调用用 offset=");
  if (hint >= 0) body = body.slice(0, hint);
  return body;
}

function jobIdOf(text: string): string {
  const match = text.match(/job-\d+/);
  if (!match) throw new Error(`job_start 响应缺少 job_id: ${text}`);
  return match[0];
}

/** Git Bash 自带的 sleep.exe，拷贝成哨兵进程用 */
function gitSleepPath(): string {
  const candidates = [
    path.join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "usr", "bin", "sleep.exe"),
    process.env.NEXUS_GIT_BASH
      ? path.join(path.dirname(process.env.NEXUS_GIT_BASH), "..", "usr", "bin", "sleep.exe")
      : "",
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`找不到 Git Bash 的 sleep.exe，试过: ${candidates.join(", ")}`);
}

/** 哨兵进程的映像名：全系统唯一，tasklist 计数不受并行测试影响 */
const SENTRY_IMAGE = "nexus-orphan-sentry.exe";

function sentryProcessCount(): number {
  const out = execFileSync("tasklist", ["/FI", `IMAGENAME eq ${SENTRY_IMAGE}`, "/FO", "CSV", "/NH"], {
    encoding: "utf8",
    windowsHide: true,
  });
  return out.split("\n").filter((line) => line.includes(SENTRY_IMAGE)).length;
}

describe("job_start / job_output 工具", () => {
  let session: StdioSession;
  let config: TempConfig;

  beforeAll(async () => {
    // maxOutputBytes 压到 4096：让 seq 1 20000（约 108KB）稳定触发有界缓冲的头尾保留
    config = writeTempConfig({ maxOutputBytes: 4096 });
    session = await connectStdio({ NEXUS_MCP_CONFIG: config.path });
  }, 30_000);

  afterAll(async () => {
    await session?.close();
    if (config) rmSync(config.dir, { recursive: true, force: true });
  });

  it(
    "job_start 立刻返回 job_id，不被命令本身阻塞",
    { timeout: 30_000 },
    async () => {
      const started = Date.now();
      const result = await callTool(session.client, "job_start", { command: "sleep 3" });
      const elapsed = Date.now() - started;
      expectOk(result);
      expect(elapsed).toBeLessThan(2_000);
      const jobId = jobIdOf(textOf(result));
      expect(jobId).toMatch(/^job-\d+$/);

      // 验收线：非冷启动（执行器与 bash 路径已热）时 job_start 必须 200ms 内返回
      const warmStart = Date.now();
      const warm = await callTool(session.client, "job_start", { command: "sleep 5" });
      const warmElapsed = Date.now() - warmStart;
      expectOk(warm);
      expect(jobIdOf(textOf(warm))).toMatch(/^job-\d+$/);
      expect(warmElapsed).toBeLessThan(200);

      // 立刻查询：命令明明要跑 3 秒，此刻必须还在运行
      const probe = await callTool(session.client, "job_output", { job_id: jobId });
      expectOk(probe);
      expect(statusOf(textOf(probe))).toBe("running");
    },
  );

  it(
    "连续启动多个任务时 id 不冲突",
    { timeout: 30_000 },
    async () => {
      const first = await callTool(session.client, "job_start", { command: "echo quick-a" });
      const second = await callTool(session.client, "job_start", { command: "echo quick-b" });
      expectOk(first);
      expectOk(second);
      expect(jobIdOf(textOf(first))).not.toBe(jobIdOf(textOf(second)));
    },
  );

  it(
    "运行中查询返回运行状态与已有输出，结束后返回退出码，增量读取不重复",
    { timeout: 30_000 },
    async () => {
      const start = await callTool(session.client, "job_start", {
        command: "echo chunk-1; sleep 0.5; echo chunk-2; sleep 0.5; echo chunk-3",
      });
      expectOk(start);
      const jobId = jobIdOf(textOf(start));

      // 轮询到第一段输出出现（任务仍在运行）
      let text = "";
      await waitFor(async () => {
        const probe = await callTool(session.client, "job_output", { job_id: jobId });
        expectOk(probe);
        text = textOf(probe);
        return bodyOf(text).includes("chunk-1");
      }, 5_000);
      expect(statusOf(text)).toBe("running");
      const firstBody = bodyOf(text);
      const offset1 = nextOffsetOf(text);
      expect(firstBody).not.toContain("chunk-2");

      // 等第二段产生后从 offset1 增量读：拿到 chunk-2，不再重复 chunk-1
      let second!: ToolResult;
      await waitFor(async () => {
        second = await callTool(session.client, "job_output", { job_id: jobId, offset: offset1 });
        expectOk(second);
        return bodyOf(textOf(second)).includes("chunk-2");
      }, 10_000);
      const secondBody = bodyOf(textOf(second));
      expect(secondBody).toContain("chunk-2");
      expect(secondBody).not.toContain("chunk-1");
      const offset2 = nextOffsetOf(textOf(second));

      // 第三段同理
      let third!: ToolResult;
      await waitFor(async () => {
        third = await callTool(session.client, "job_output", { job_id: jobId, offset: offset2 });
        expectOk(third);
        return bodyOf(textOf(third)).includes("chunk-3");
      }, 10_000);
      const thirdBody = bodyOf(textOf(third));
      expect(thirdBody).toContain("chunk-3");
      expect(thirdBody).not.toContain("chunk-2");

      // 任务结束后：最终状态 + 退出码 + 完整输出可反复查看
      await waitFor(async () => {
        const probe = await callTool(session.client, "job_output", { job_id: jobId });
        expectOk(probe);
        text = textOf(probe);
        return statusOf(text) === "exited";
      }, 10_000);
      expect(exitCodeOf(text)).toBe(0);
    },
  );

  it(
    "非零退出码与标准错误正常返回",
    { timeout: 30_000 },
    async () => {
      const start = await callTool(session.client, "job_start", {
        command: "echo bad-output >&2; exit 3",
      });
      expectOk(start);
      const jobId = jobIdOf(textOf(start));
      let text = "";
      await waitFor(async () => {
        const probe = await callTool(session.client, "job_output", { job_id: jobId });
        expectOk(probe);
        text = textOf(probe);
        return statusOf(text) === "exited";
      }, 10_000);
      expect(exitCodeOf(text)).toBe(3);
      expect(bodyOf(text)).toContain("bad-output");
    },
  );

  it(
    "不存在的 job_id 返回明确错误，不返回空结果",
    { timeout: 30_000 },
    async () => {
      const result = await callTool(session.client, "job_output", { job_id: "job-99999" });
      expect(result.isError).toBe(true);
      const text = textOf(result);
      expect(text).toContain("job-99999");
      expect(text).toContain("不存在");
    },
  );

  it(
    "超长输出采用有界缓冲：保留头尾并标注省略量",
    { timeout: 30_000 },
    async () => {
      const start = await callTool(session.client, "job_start", { command: "seq 1 20000" });
      expectOk(start);
      const jobId = jobIdOf(textOf(start));
      let text = "";
      await waitFor(async () => {
        const probe = await callTool(session.client, "job_output", { job_id: jobId });
        expectOk(probe);
        text = textOf(probe);
        return statusOf(text) === "exited";
      }, 15_000);
      expect(exitCodeOf(text)).toBe(0);

      // 头部：不出现省略标记
      const head = await callTool(session.client, "job_output", { job_id: jobId, offset: 0 });
      expectOk(head);
      expect(bodyOf(textOf(head))).not.toBe("");
      expect(textOf(head)).not.toContain("bytes omitted");
      expect(bodyOf(textOf(head))).toMatch(/^1\n/);

      // 中段：已丢弃的区间给出省略标注并跳到尾部
      let text2 = textOf(head);
      let sawMarker = false;
      for (let i = 0; i < 6; i++) {
        const body = bodyOf(text2);
        if (body.includes("20000")) break;
        if (body.includes("bytes omitted")) {
          sawMarker = true;
          expect(body).toMatch(/\.\.\. \d+ bytes omitted \.\.\./);
        }
        const step = await callTool(session.client, "job_output", { job_id: jobId, offset: nextOffsetOf(text2) });
        expectOk(step);
        text2 = textOf(step);
      }
      expect(sawMarker).toBe(true);
      expect(bodyOf(text2)).toContain("20000");
    },
  );

  it(
    "服务退出时终止所有后台任务，不残留子进程",
    { timeout: 60_000 },
    async () => {
      const orphanConfig = writeTempConfig();
      // 独立 root：把 Git Bash 的 sleep.exe 拷成全系统唯一的哨兵名，
      // 任务跑 300 秒，退出清理后必须消失
      const orphanRoot = mkdtempSync(path.join(os.tmpdir(), "nexus-mcp-jobs-root-"));
      const sentryBinary = path.join(orphanRoot, SENTRY_IMAGE);
      copyFileSync(gitSleepPath(), sentryBinary);
      writeFileSync(
        orphanConfig.path,
        JSON.stringify(
          { root: orphanRoot, transport: "stdio", shell: "auto" },
          null,
          2,
        ),
        "utf8",
      );
      const orphanSession = await connectStdio({ NEXUS_MCP_CONFIG: orphanConfig.path });
      try {
        const baseline = sentryProcessCount();
        const start = await callTool(orphanSession.client, "job_start", {
          command: `./${SENTRY_IMAGE} 300`,
        });
        expectOk(start);
        await waitFor(async () => sentryProcessCount() === baseline + 1, 10_000);

        // 服务退出（transport close 会终止 dist 进程 → 执行器 stdin 收到 EOF → 清理后台任务）
        await orphanSession.close();
        await waitFor(async () => sentryProcessCount() === baseline, 15_000, 250);
      } finally {
        await orphanSession?.close().catch(() => {});
        rmSync(orphanRoot, { recursive: true, force: true });
        rmSync(orphanConfig.dir, { recursive: true, force: true });
      }
    },
  );
});
