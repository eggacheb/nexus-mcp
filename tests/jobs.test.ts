import { expectOk } from "./support/tool.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
/** 孙进程测试的映像名：同样是唯一名，避免和并发测试里的同名进程混淆 */
const GRANDCHILD_IMAGE = "nexus-kill-grandchild.exe";

/** 按映像名精确计数：映像名全系统唯一时，计数就是这族进程的条数 */
function imageProcessCount(image: string): number {
  const out = execFileSync("tasklist", ["/FI", `IMAGENAME eq ${image}`, "/FO", "CSV", "/NH"], {
    encoding: "utf8",
    windowsHide: true,
  });
  return out.split("\n").filter((line) => line.includes(image)).length;
}

function sentryProcessCount(): number {
  return imageProcessCount(SENTRY_IMAGE);
}

/** job_kill 回执里的 killed 行 */
function killedOf(text: string): boolean | null {
  const match = text.match(/^killed: (true|false)$/m);
  return match ? match[1] === "true" : null;
}

/** Windows 原生 ping.exe：拷成唯一映像名后，孙进程断言不依赖 MSYS pid */
function windowsPingPath(): string {
  const candidate = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "PING.EXE");
  if (!existsSync(candidate)) throw new Error(`找不到 Windows 原生 ping: ${candidate}`);
  return candidate;
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
    "job_start 的 cwd 通过目录链接指向沙箱根外时被拒绝",
    { timeout: 25_000 },
    async (t) => {
      const sandboxRoot = mkdtempSync(path.join(os.tmpdir(), "nexus-job-root-"));
      const outsideDir = mkdtempSync(path.join(os.tmpdir(), "nexus-job-out-"));
      const linkPath = path.join(sandboxRoot, "escape-link");
      let linked = false;
      try {
        symlinkSync(outsideDir, linkPath, "junction");
        linked = true;
      } catch {
        // ignore
      }
      const cfg = writeTempConfig();
      writeFileSync(
        cfg.path,
        JSON.stringify({ root: sandboxRoot, transport: "stdio", shell: "auto" }, null, 2),
        "utf8",
      );
      const isolated = await connectStdio({ NEXUS_MCP_CONFIG: cfg.path });
      try {
        if (!linked) {
          t.skip();
          return;
        }
        const escaped = await callTool(isolated.client, "job_start", {
          command: "pwd",
          cwd: "escape-link",
        });
        expect(escaped.isError).toBe(true);
        expect(textOf(escaped)).toContain("路径越界");
      } finally {
        await isolated.close();
        rmSync(linkPath, { recursive: true, force: true });
        rmSync(sandboxRoot, { recursive: true, force: true });
        rmSync(outsideDir, { recursive: true, force: true });
        rmSync(cfg.dir, { recursive: true, force: true });
      }
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
    "非 UTF-8 输出在 job_output 中按 lossy 推进偏移，不卡死且不漏后续文本",
    { timeout: 20_000 },
    async () => {
      const start = await callTool(session.client, "job_start", {
        command: "printf 'JOB_BEFORE\\x80\\xff\\xc4\\xe3JOB_AFTER\\n'",
      });
      expectOk(start);
      const jobId = jobIdOf(textOf(start));

      await waitFor(async () => {
        const probe = await callTool(session.client, "job_output", { job_id: jobId });
        expectOk(probe);
        return statusOf(textOf(probe)) === "exited";
      }, 10_000);

      let offset = 0;
      let combined = "";
      let lastRaw = "";
      for (let step = 0; step < 5; step++) {
        const page = await callTool(session.client, "job_output", { job_id: jobId, offset });
        expectOk(page);
        lastRaw = textOf(page);
        combined += bodyOf(lastRaw);
        if (!lastRaw.includes("下次调用用 offset=")) break;
        const next = nextOffsetOf(lastRaw);
        expect(next).toBeGreaterThan(offset);
        offset = next;
      }
      expect(combined).toContain("JOB_BEFORE");
      expect(combined).toContain("JOB_AFTER");
      expect(lastRaw).not.toContain("下次调用用 offset=");
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

        // 服务退出（即便此刻执行器正阻塞在同步长耗时 bash，stdio 退出也必须经 closeExecutor 树杀后台任务，不等 60 秒）
        const blockingBash = callTool(orphanSession.client, "bash", {
          command: "sleep 60",
          timeout_ms: 60_000,
        }).catch(() => undefined);
        await new Promise((r) => setTimeout(r, 300));
        await orphanSession.close();
        await blockingBash;
        await waitFor(async () => sentryProcessCount() === baseline, 8_000, 200);
      } finally {
        await orphanSession?.close().catch(() => {});
        rmSync(orphanRoot, { recursive: true, force: true });
        rmSync(orphanConfig.dir, { recursive: true, force: true });
      }
    },
  );
});

describe("job_kill 工具", () => {
  let session: StdioSession;
  let config: TempConfig;

  beforeAll(async () => {
    config = writeTempConfig();
    session = await connectStdio({ NEXUS_MCP_CONFIG: config.path });
  }, 30_000);

  afterAll(async () => {
    await session?.close();
    if (config) rmSync(config.dir, { recursive: true, force: true });
  });

  it(
    "杀运行中任务：立即返回 killed=true 回执，状态与退出码靠 job_output 收敛",
    { timeout: 60_000 },
    async () => {
      const start = await callTool(session.client, "job_start", { command: "sleep 30" });
      expectOk(start);
      const jobId = jobIdOf(textOf(start));

      const startedAt = Date.now();
      const killed = await callTool(session.client, "job_kill", { job_id: jobId });
      const elapsed = Date.now() - startedAt;
      expectOk(killed);
      const receipt = textOf(killed);
      // 回执式：不等进程退出，杀完立刻回
      expect(elapsed).toBeLessThan(2_000);
      expect(killedOf(receipt)).toBe(true);
      expect(statusOf(receipt)).toBe("running");
      expect(exitCodeOf(receipt)).toBeNull();

      // 退出确认由监控线程收敛，模型用 job_output 轮询
      let text = "";
      await waitFor(async () => {
        const probe = await callTool(session.client, "job_output", { job_id: jobId });
        expectOk(probe);
        text = textOf(probe);
        return statusOf(text) === "exited";
      }, 10_000);
      expect(exitCodeOf(text)).not.toBe(0);
    },
  );

  it(
    "杀已退出任务：killed=false + 已记录退出码，不报错",
    { timeout: 30_000 },
    async () => {
      const start = await callTool(session.client, "job_start", { command: "echo finished-early" });
      expectOk(start);
      const jobId = jobIdOf(textOf(start));
      await waitFor(async () => {
        const probe = await callTool(session.client, "job_output", { job_id: jobId });
        expectOk(probe);
        return statusOf(textOf(probe)) === "exited";
      }, 10_000);

      const killed = await callTool(session.client, "job_kill", { job_id: jobId });
      expectOk(killed);
      const receipt = textOf(killed);
      expect(killedOf(receipt)).toBe(false);
      expect(statusOf(receipt)).toBe("exited");
      expect(exitCodeOf(receipt)).toBe(0);
    },
  );

  it("未知 job_id：报错形状与 job_output 一致", { timeout: 30_000 }, async () => {
    const result = await callTool(session.client, "job_kill", { job_id: "job-99999" });
    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toContain("job-99999");
    expect(text).toContain("不存在");
  });

  it(
    "树内 detached 孙进程随任务一起终止",
    { timeout: 60_000 },
    async () => {
      // 独立 root：把 Windows 原生 ping 拷成全系统唯一的映像名，
      // 孙进程断言按映像名精确计数，不受并发测试影响
      const root = mkdtempSync(path.join(os.tmpdir(), "nexus-mcp-kill-root-"));
      copyFileSync(windowsPingPath(), path.join(root, GRANDCHILD_IMAGE));
      const childConfig = writeTempConfig();
      writeFileSync(
        childConfig.path,
        JSON.stringify({ root, transport: "stdio", shell: "auto" }, null, 2),
        "utf8",
      );
      const childSession = await connectStdio({ NEXUS_MCP_CONFIG: childConfig.path });
      try {
        const baseline = imageProcessCount(GRANDCHILD_IMAGE);
        const start = await callTool(childSession.client, "job_start", {
          command: `nohup ./${GRANDCHILD_IMAGE} -n 60 127.0.0.1 >/dev/null 2>&1 & echo grandchild-started; sleep 30`,
        });
        expectOk(start);
        const jobId = jobIdOf(textOf(start));
        await waitFor(async () => imageProcessCount(GRANDCHILD_IMAGE) === baseline + 1, 15_000);

        const killed = await callTool(childSession.client, "job_kill", { job_id: jobId });
        expectOk(killed);
        expect(killedOf(textOf(killed))).toBe(true);

        // Job Object + taskkill 双保险：detached 孙进程必须一起消失
        await waitFor(async () => imageProcessCount(GRANDCHILD_IMAGE) === baseline, 15_000, 200);
      } finally {
        await childSession?.close().catch(() => {});
        // 断言失败时孙进程可能还活着、握着 exe 句柄，清理失败不能盖住原始错误
        try {
          rmSync(root, { recursive: true, force: true });
        } catch {
          // 临时目录留在 %TEMP%，由系统清理
        }
        rmSync(childConfig.dir, { recursive: true, force: true });
      }
    },
  );

  it(
    "杀后既有输出照常可读，增量读取不重复",
    { timeout: 60_000 },
    async () => {
      const start = await callTool(session.client, "job_start", {
        command: "echo before-kill; sleep 30",
      });
      expectOk(start);
      const jobId = jobIdOf(textOf(start));

      let text = "";
      await waitFor(async () => {
        const probe = await callTool(session.client, "job_output", { job_id: jobId });
        expectOk(probe);
        text = textOf(probe);
        return bodyOf(text).includes("before-kill");
      }, 10_000);
      expect(statusOf(text)).toBe("running");
      const offset = nextOffsetOf(text);

      const killed = await callTool(session.client, "job_kill", { job_id: jobId });
      expectOk(killed);
      expect(killedOf(textOf(killed))).toBe(true);

      // 从上次偏移继续读：不重复旧内容，状态已收敛
      let after = "";
      await waitFor(async () => {
        const probe = await callTool(session.client, "job_output", { job_id: jobId, offset });
        expectOk(probe);
        after = textOf(probe);
        return statusOf(after) === "exited";
      }, 10_000);
      expect(bodyOf(after)).not.toContain("before-kill");

      // 从头再读：既有输出仍在缓冲里
      const replay = await callTool(session.client, "job_output", { job_id: jobId, offset: 0 });
      expectOk(replay);
      expect(bodyOf(textOf(replay))).toContain("before-kill");
    },
  );
});
