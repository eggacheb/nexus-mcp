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
  let mainConfig: { path: string; dir: string };

  beforeAll(async () => {
    mainConfig = writeTempConfig();
    session = await connectStdio({ NEXUS_MCP_CONFIG: mainConfig.path });
  }, 30_000);

  afterAll(async () => {
    await session?.close();
    if (mainConfig) rmSync(mainConfig.dir, { recursive: true, force: true });
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

  it("多行命令中的危险子命令在 bash 与 job_start 下均被拦截", { timeout: 15_000 }, async () => {
    const cmd = "echo safe\nrm -rf /tmp/nexus-policy-probe-should-not-exist";
    const bashRes = await callTool(session.client, "bash", { command: cmd });
    expect(bashRes.isError).toBe(true);
    expect(textOf(bashRes)).toContain("递归强制删除");
    expect(textOf(bashRes)).toContain("替代方案");

    const jobRes = await callTool(session.client, "job_start", { command: cmd });
    expect(jobRes.isError).toBe(true);
    expect(textOf(jobRes)).toContain("递归强制删除");
  });

  it("子 shell、花括号组与控制流分支中的危险命令被拦截，未闭合括号 fail-closed", { timeout: 20_000 }, async () => {
    for (const cmd of [
      "(rm -rf /tmp/nexus-policy-probe-should-not-exist)",
      "echo safe && (rm -rf /tmp/nexus-policy-probe-should-not-exist)",
      "{ rm -rf /tmp/nexus-policy-probe-should-not-exist; }",
      "if true; then rm -rf /tmp/nexus-policy-probe-should-not-exist; fi",
    ]) {
      const res = await callTool(session.client, "bash", { command: cmd });
      expect(res.isError, `${cmd} 应被拦截`).toBe(true);
      expect(textOf(res)).toContain("递归强制删除");
    }

    const jobSubshell = await callTool(session.client, "job_start", {
      command: "(rm -rf /tmp/nexus-policy-probe-should-not-exist)",
    });
    expect(jobSubshell.isError).toBe(true);
    expect(textOf(jobSubshell)).toContain("递归强制删除");

    const unclosed = await callTool(session.client, "bash", { command: "(echo unclosed" });
    expect(unclosed.isError).toBe(true);
    expect(textOf(unclosed)).toContain("无法解析");
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

        const multilineDenied = await callTool(session.client, "bash", {
          command: "echo whitelisted\ncurl https://example.com",
        });
        expect(multilineDenied.isError).toBe(true);
        expect(textOf(multilineDenied)).toContain("白名单");
        expect(textOf(multilineDenied)).toContain("curl");

        const subshellDenied = await callTool(session.client, "bash", {
          command: "(curl https://example.com)",
        });
        expect(subshellDenied.isError).toBe(true);
        expect(textOf(subshellDenied)).toContain("白名单");
        expect(textOf(subshellDenied)).toContain("curl");

        const subshellAllowed = await callTool(session.client, "bash", {
          command: "(echo subshell-ok)",
        });
        expectOk(subshellAllowed);
        expect(textOf(subshellAllowed)).toContain("subshell-ok");
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

        for (const bypass of ["echo ok\ngit push origin dev", "(git push origin dev)"]) {
          const bypassed = await callTool(session.client, "bash", { command: bypass });
          expect(bypassed.isError, `${bypass} 应被黑名单拦截`).toBe(true);
          expect(textOf(bypassed)).toContain("git push *");
          expect(textOf(bypassed)).toContain("替代方案");
        }
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

  it(
    "pwsh 模式下非段首括号子表达式与花括号脚本块同样受危险表与白/黑名单约束",
    { timeout: 25_000 },
    async () => {
      const config = writeTempConfig({
        shell: "pwsh",
        commandPolicy: { allow: ["echo *"], deny: ["git push *"], onUnmatched: "deny" },
      });
      const session = await connectStdio({ NEXUS_MCP_CONFIG: config.path });
      try {
        const subexprDanger = await callTool(session.client, "bash", {
          command: "echo (Remove-Item -Recurse -Force C:\\temp\\nexus-probe-never)",
        });
        expect(subexprDanger.isError).toBe(true);
        expect(textOf(subexprDanger)).toContain("强制删除");

        const blockDeny = await callTool(session.client, "bash", {
          command: "if ($true) { git push origin dev }",
        });
        expect(blockDeny.isError).toBe(true);
        expect(textOf(blockDeny)).toContain("git push *");

        const subexprUnmatched = await callTool(session.client, "bash", {
          command: "echo (curl https://example.com)",
        });
        expect(subexprUnmatched.isError).toBe(true);
        expect(textOf(subexprUnmatched)).toContain("curl");

        const blockAllowed = await callTool(session.client, "bash", {
          command: "if ($true) { echo pwsh-block-ok }",
        });
        expectOk(blockAllowed);
        expect(textOf(blockAllowed)).toContain("pwsh-block-ok");
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
