import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TOKEN = "test-token-6f3c1a";

const ALL_TOOLS = [
  "bash",
  "edit",
  "glob",
  "grep",
  "job_output",
  "job_start",
  "read",
  "write",
];

interface RunningServer {
  port: number;
  url: URL;
  stderrText(): string;
  stop(): Promise<void>;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

function waitForPort(port: number, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = net.connect({ port, host: "127.0.0.1" });
      socket.once("connect", () => {
        socket.destroy();
        resolve();
      });
      socket.once("error", () => {
        socket.destroy();
        if (Date.now() > deadline) {
          reject(new Error(`服务在 ${timeoutMs}ms 内没有监听 ${port}`));
          return;
        }
        setTimeout(attempt, 50);
      });
    };
    attempt();
  });
}

async function startServer(token: string): Promise<RunningServer> {
  const port = await freePort();
  const configDir = mkdtempSync(path.join(os.tmpdir(), "nexus-mcp-http-"));
  const configPath = path.join(configDir, "config.json");
  writeFileSync(
    configPath,
    JSON.stringify({ root: projectRoot, transport: "http", port, token }, null, 2),
    "utf8",
  );

  const child: ChildProcess = spawn(process.execPath, [path.join(projectRoot, "dist", "index.js")], {
    cwd: projectRoot,
    env: { ...process.env, NEXUS_MCP_CONFIG: configPath },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });

  try {
    await waitForPort(port);
  } catch (error) {
    child.kill();
    rmSync(configDir, { recursive: true, force: true });
    throw new Error(`${(error as Error).message}\n服务输出:\n${stderr}`);
  }

  return {
    port,
    url: new URL(`http://127.0.0.1:${port}/mcp`),
    stderrText: () => stderr,
    async stop() {
      child.kill();
      rmSync(configDir, { recursive: true, force: true });
      await new Promise<void>((resolve) => {
        child.once("exit", () => resolve());
        setTimeout(resolve, 3000);
      });
    },
  };
}

function authInit(token: string): { requestInit: { headers: Record<string, string> } } {
  return { requestInit: { headers: { Authorization: `Bearer ${token}` } } };
}

function textOf(result: { content?: unknown }): string {
  const parts = (result.content as Array<{ type: string; text?: string }> | undefined) ?? [];
  return parts.map((part) => part.text ?? "").join("\n");
}

async function connectClient(
  url: URL,
  options?: ConstructorParameters<typeof StreamableHTTPClientTransport>[1],
): Promise<{ client: Client; transport: StreamableHTTPClientTransport }> {
  const transport = new StreamableHTTPClientTransport(url, options);
  const client = new Client({ name: "vitest-http", version: "0.1.0" });
  await client.connect(transport);
  return { client, transport };
}

type CodedError = Error & { code?: number };

async function connectError(
  url: URL,
  options?: ConstructorParameters<typeof StreamableHTTPClientTransport>[1],
): Promise<CodedError> {
  const transport = new StreamableHTTPClientTransport(url, options);
  const client = new Client({ name: "vitest-http", version: "0.1.0" });
  const error = await client.connect(transport).then(
    () => null,
    (err: unknown) => err as CodedError,
  );
  if (!error) throw new Error("预期连接失败，实际连上了");
  return error;
}

/** 带着已失效的会话 id 发普通请求，客户端不会重新 initialize，直接打服务端 */
async function staleSessionError(url: URL, sessionId: string): Promise<CodedError> {
  const transport = new StreamableHTTPClientTransport(url, { ...authInit(TOKEN), sessionId });
  const client = new Client({ name: "vitest-http", version: "0.1.0" });
  await client.connect(transport);
  const error = await client.listTools().then(
    () => null,
    (err: unknown) => err as CodedError,
  );
  if (!error) throw new Error("预期旧会话被拒，实际调通了");
  return error;
}

function nonLoopbackIPv4(): string | undefined {
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === "IPv4" && !address.internal) return address.address;
    }
  }
  return undefined;
}

describe("HTTP 传输（配置了令牌）", () => {
  let server: RunningServer;

  beforeAll(async () => {
    server = await startServer(TOKEN);
  }, 30_000);

  afterAll(async () => {
    await server?.stop();
  });

  it(
    "官方客户端经 HTTP 初始化后可以列出 8 个工具并调用",
    async () => {
      const { client, transport } = await connectClient(server.url, authInit(TOKEN));

      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name).sort()).toEqual(ALL_TOOLS);
      expect(transport.sessionId).toBeTruthy();

      const result = await client.callTool({
        name: "read",
        arguments: { path: "package.json" },
      });
      expect(result.isError).toBeFalsy();
      expect(textOf(result)).toContain("package.json");

      await transport.terminateSession();
      await client.close();
    },
    20_000,
  );

  it(
    "缺少 Authorization 头返回 401，并说明缺什么",
    async () => {
      const error = await connectError(server.url);
      expect(error.code).toBe(401);
      expect(error.message).toContain("Authorization");
      expect(error.message).toContain("Bearer");
    },
    20_000,
  );

  it(
    "令牌不正确返回 401",
    async () => {
      const error = await connectError(server.url, authInit("wrong-token"));
      expect(error.code).toBe(401);
      expect(error.message).toContain("令牌不正确");
    },
    20_000,
  );

  it(
    "正确令牌放行，令牌不出现在服务日志里",
    async () => {
      const { client, transport } = await connectClient(server.url, authInit(TOKEN));
      const { tools } = await client.listTools();
      expect(tools.length).toBe(8);
      await transport.terminateSession();
      await client.close();

      const logs = server.stderrText();
      expect(logs.length).toBeGreaterThan(0);
      expect(logs).not.toContain(TOKEN);
      expect(logs).not.toContain("wrong-token");
      expect(logs.toLowerCase()).not.toContain("authorization");
    },
    20_000,
  );

  it(
    "两个客户端各自初始化，会话 id 不同且工具调用互不影响",
    async () => {
      const first = await connectClient(server.url, authInit(TOKEN));
      const second = await connectClient(server.url, authInit(TOKEN));

      expect(first.transport.sessionId).toBeTruthy();
      expect(second.transport.sessionId).toBeTruthy();
      expect(first.transport.sessionId).not.toBe(second.transport.sessionId);

      const firstRead = await first.client.callTool({
        name: "read",
        arguments: { path: "package.json" },
      });
      const secondRead = await second.client.callTool({
        name: "read",
        arguments: { path: "tsconfig.json" },
      });

      expect(textOf(firstRead)).toContain("package.json");
      expect(textOf(firstRead)).not.toContain("tsconfig.json");
      expect(textOf(secondRead)).toContain("tsconfig.json");

      // 一个客户端退出不应该影响另一个
      await first.transport.terminateSession();
      await first.client.close();

      const afterClose = await second.client.callTool({
        name: "read",
        arguments: { path: "AGENTS.md" },
      });
      expect(afterClose.isError).toBeFalsy();
      expect(textOf(afterClose)).toContain("AGENTS.md");

      await second.transport.terminateSession();
      await second.client.close();
    },
    25_000,
  );

  it(
    "会话结束后释放，旧会话 id 不能继续使用",
    async () => {
      const { client, transport } = await connectClient(server.url, authInit(TOKEN));
      const sessionId = transport.sessionId;
      expect(sessionId).toBeTruthy();

      await transport.terminateSession();
      await client.close();

      const error = await staleSessionError(server.url, sessionId);
      expect(error.code).toBe(404);
      expect(error.message).toContain("会话");
    },
    20_000,
  );

  it(
    "连续重连五轮后服务仍正常，最早那一轮会话已失效",
    async () => {
      const sessionIds: string[] = [];
      for (let round = 0; round < 5; round += 1) {
        const { client, transport } = await connectClient(server.url, authInit(TOKEN));
        sessionIds.push(transport.sessionId ?? "");
        await transport.terminateSession();
        await client.close();
      }
      expect(new Set(sessionIds).size).toBe(5);

      const { client, transport } = await connectClient(server.url, authInit(TOKEN));
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name).sort()).toEqual(ALL_TOOLS);
      await transport.terminateSession();
      await client.close();

      const staleId = sessionIds[0];
      expect(staleId).toBeTruthy();
      const error = await staleSessionError(server.url, staleId as string);
      expect(error.code).toBe(404);
      expect(error.message).toContain("会话");
    },
    40_000,
  );
});

describe("HTTP 传输（没有配置令牌）", () => {
  let server: RunningServer;

  beforeAll(async () => {
    server = await startServer("");
  }, 30_000);

  afterAll(async () => {
    await server?.stop();
  });

  it(
    "本机客户端不需要令牌就能连上",
    async () => {
      const { client, transport } = await connectClient(server.url);
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name).sort()).toEqual(ALL_TOOLS);
      await transport.terminateSession();
      await client.close();
    },
    20_000,
  );

  it(
    "非 loopback 地址连不进来",
    async () => {
      const lan = nonLoopbackIPv4();
      if (!lan) return;

      const error = await connectError(new URL(`http://${lan}:${server.port}/mcp`));
      // 连不上是网络层拒绝，不是服务端返回的 401/403
      expect(error.code).toBeUndefined();
    },
    20_000,
  );
});
