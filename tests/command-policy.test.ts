import { expectOk } from "./support/tool.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

/** 起一个 stdio 模式的真实 dist 进程，env 透传给服务进程（用来覆盖配置路径） */
async function connectStdio(env: Record<string, string> = {}): Promise<StdioSession> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(projectRoot, "dist", "index.js"), "--stdio"],
    cwd: projectRoot,
    env: { ...process.env, ...env } as Record<string, string>,
    stderr: "ignore",
  });
  const client = new Client({ name: "vitest-command-policy", version: "0.1.0" });
  await client.connect(transport);
  return {
    client,
    async close() {
      await client.close();
    },
  };
}

function writeTempConfig(overrides: Record<string, unknown> = {}): { path: string; dir: string } {
  const dir = mkdtempSync(path.join(os.tmpdir(), "nexus-mcp-policy-"));
  const configPath = path.join(dir, "config.json");
  writeFileSync(
    configPath,
    JSON.stringify({ root: projectRoot, transport: "stdio", ...overrides }, null, 2),
    "utf8",
  );
  return { path: configPath, dir };
}

/** 起 dist 进程等到它退出，收集 stderr；用于验证启动即报错的配置 */
function serverStderr(configPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(projectRoot, "dist", "index.js"), "--stdio"], {
      cwd: projectRoot,
      env: { ...process.env, NEXUS_MCP_CONFIG: configPath } as Record<string, string>,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let collected = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      collected += chunk;
    });
    child.on("exit", () => resolve(collected));
    child.on("error", reject);
  });
}

async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  return (await client.callTool({ name, arguments: args })) as ToolResult;
}

describe("命令闸门（默认配置：仅内置危险表）", () => {
  let session: StdioSession;

  beforeAll(async () => {
    session = await connectStdio();
  }, 30_000);

  afterAll(async () => {
    await session?.close();
  });

  it(
    "rm -rf 在执行前被拦并说明规则与替代方案",
    { timeout: 15_000 },
    async () => {
      const result = await callTool(session.client, "bash", { command: "rm -rf /tmp/example" });
      expect(result.isError).toBe(true);
      const text = textOf(result);
      expect(text).toContain("rm -rf /tmp/example");
      expect(text).toContain("递归强制删除");
      expect(text).toContain("替代方案");
    },
  );

  it("未命中危险表的命令照常执行", { timeout: 15_000 }, async () => {
    const result = await callTool(session.client, "bash", { command: "echo hello-nexus" });
    expectOk(result);
    expect(textOf(result)).toContain("exit_code: 0");
    expect(textOf(result)).toContain("hello-nexus");
  });

  it("job_start 同样过闸门", { timeout: 15_000 }, async () => {
    const result = await callTool(session.client, "job_start", { command: "rm -rf /tmp/example" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("递归强制删除");
  });

  it("引号不闭合的命令按 fail-closed 拒绝", { timeout: 15_000 }, async () => {
    const result = await callTool(session.client, "bash", { command: 'echo "unclosed' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("无法解析");
  });
});

describe("命令闸门（白名单）", () => {
  it(
    "白名单非空时未命中的命令默认拒绝",
    { timeout: 20_000 },
    async () => {
      const config = writeTempConfig({
        commandPolicy: { allow: ["echo *", "pwd"], deny: [], onUnmatched: "deny" },
      });
      const session = await connectStdio({ NEXUS_MCP_CONFIG: config.path });
      try {
        const allowed = await callTool(session.client, "bash", { command: "echo whitelisted" });
        expectOk(allowed);
        expect(textOf(allowed)).toContain("whitelisted");

        const denied = await callTool(session.client, "bash", { command: "curl https://example.com" });
        expect(denied.isError).toBe(true);
        const text = textOf(denied);
        expect(text).toContain("白名单");
        expect(text).toContain("echo *");
        expect(text).toContain("curl");
      } finally {
        await session.close();
        rmSync(config.dir, { recursive: true, force: true });
      }
    },
  );

  it(
    "onUnmatched 为 allow 时未命中放行",
    { timeout: 20_000 },
    async () => {
      const config = writeTempConfig({
        commandPolicy: { allow: ["echo *"], deny: [], onUnmatched: "allow" },
      });
      const session = await connectStdio({ NEXUS_MCP_CONFIG: config.path });
      try {
        const result = await callTool(session.client, "bash", { command: "pwd" });
        expectOk(result);
        expect(textOf(result)).toContain("exit_code: 0");
      } finally {
        await session.close();
        rmSync(config.dir, { recursive: true, force: true });
      }
    },
  );

  it(
    "白名单放行的命令不绕过沙箱：越界 cwd 仍被拒绝",
    { timeout: 20_000 },
    async () => {
      const config = writeTempConfig({
        commandPolicy: { allow: ["echo *"], deny: [], onUnmatched: "deny" },
      });
      const session = await connectStdio({ NEXUS_MCP_CONFIG: config.path });
      try {
        const result = await callTool(session.client, "bash", {
          command: "echo hi",
          cwd: path.dirname(projectRoot),
        });
        expect(result.isError).toBe(true);
        expect(textOf(result)).toContain("越界");
      } finally {
        await session.close();
        rmSync(config.dir, { recursive: true, force: true });
      }
    },
  );
});

describe("命令闸门（黑名单与归一化）", () => {
  it(
    "命中黑名单的命令被拒并说明命中的规则",
    { timeout: 20_000 },
    async () => {
      const config = writeTempConfig({
        commandPolicy: { allow: [], deny: ["git push *"], onUnmatched: "deny" },
      });
      const session = await connectStdio({ NEXUS_MCP_CONFIG: config.path });
      try {
        const result = await callTool(session.client, "bash", { command: "git push origin dev" });
        expect(result.isError).toBe(true);
        const text = textOf(result);
        expect(text).toContain("git push *");
        expect(text).toContain("git push origin dev");
        expect(text).toContain("替代方案");
      } finally {
        await session.close();
        rmSync(config.dir, { recursive: true, force: true });
      }
    },
  );

  it(
    "可执行名归一化：大写与 .exe 后缀不影响拦截",
    { timeout: 20_000 },
    async () => {
      const config = writeTempConfig({
        commandPolicy: { allow: [], deny: [], onUnmatched: "deny" },
      });
      const session = await connectStdio({ NEXUS_MCP_CONFIG: config.path });
      try {
        const result = await callTool(session.client, "bash", { command: "RM.EXE -RF x" });
        expect(result.isError).toBe(true);
        expect(textOf(result)).toContain("递归强制删除");
      } finally {
        await session.close();
        rmSync(config.dir, { recursive: true, force: true });
      }
    },
  );
});

describe("命令闸门（配置校验）", () => {
  it(
    "onUnmatched 非法值启动即报错",
    { timeout: 20_000 },
    async () => {
      const config = writeTempConfig({
        commandPolicy: { allow: [], deny: [], onUnmatched: "ask" },
      });
      try {
        const stderr = await serverStderr(config.path);
        expect(stderr).toContain("onUnmatched");
      } finally {
        rmSync(config.dir, { recursive: true, force: true });
      }
    },
  );

  it(
    "allow/deny 不是字符串数组时启动即报错",
    { timeout: 20_000 },
    async () => {
      const config = writeTempConfig({ commandPolicy: { allow: "git *", deny: [] } });
      try {
        const stderr = await serverStderr(config.path);
        expect(stderr).toContain("commandPolicy.allow");
      } finally {
        rmSync(config.dir, { recursive: true, force: true });
      }
    },
  );
});
