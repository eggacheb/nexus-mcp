import { expectOk } from "./support/tool.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { startServer } from "./support/server.js";
import type { RunningServer } from "./support/server.js";

const TOKEN = "test-token-6f3c1a";

const ALL_TOOLS = [
  "bash",
  "edit",
  "glob",
  "grep",
  "job_kill",
  "job_output",
  "job_start",
  "read",
  "write",
];

function authInit(token: string): { requestInit: { headers: Record<string, string> } } {
  return { requestInit: { headers: { Authorization: `Bearer ${token}` } } };
}

function textOf(result: unknown): string {
  const parts = ((result as { content?: unknown }).content as Array<{ type: string; text?: string }> | undefined) ?? [];
  return parts.map((part) => part.text ?? "").join("\n");
}

function newClient(): Client {
  return new Client({ name: "vitest-http", version: "0.1.0" });
}

async function connectClient(
  url: URL,
  options?: ConstructorParameters<typeof StreamableHTTPClientTransport>[1],
): Promise<{ client: Client; transport: StreamableHTTPClientTransport }> {
  const transport = new StreamableHTTPClientTransport(url, options);
  const client = newClient();
  await client.connect(transport);
  return { client, transport };
}

type CodedError = Error & { code?: number };

async function connectError(
  url: URL,
  options?: ConstructorParameters<typeof StreamableHTTPClientTransport>[1],
): Promise<CodedError> {
  const transport = new StreamableHTTPClientTransport(url, options);
  const client = newClient();
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
  const client = newClient();
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
    server = await startServer({ token: TOKEN });
  }, 30_000);

  afterAll(async () => {
    await server?.stop();
  });

  it(
    "官方客户端经 HTTP 初始化后可以列出 9 个工具并调用",
    async () => {
      const { client, transport } = await connectClient(server.mcpUrl, authInit(TOKEN));

      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name).sort()).toEqual(ALL_TOOLS);
      expect(transport.sessionId).toBeTruthy();

      const result = await client.callTool({
        name: "read",
        arguments: { path: "package.json" },
      });
      expectOk(result);
      expect(textOf(result)).toContain('"name": "nexus-mcp"');

      await transport.terminateSession();
      await client.close();
    },
    20_000,
  );

  it(
    "免鉴权提供 /favicon.ico、/favicon.svg 与 /icon.png 供连接器展示图标",
    async () => {
      const base = `http://127.0.0.1:${server.port}`;

      const ico = await fetch(`${base}/favicon.ico`);
      expect(ico.status).toBe(200);
      expect(ico.headers.get("content-type")).toContain("image/x-icon");
      const icoBuf = Buffer.from(await ico.arrayBuffer());
      expect(icoBuf.subarray(0, 4)).toEqual(Buffer.from([0x00, 0x00, 0x01, 0x00]));

      const icoHead = await fetch(`${base}/favicon.ico`, { method: "HEAD" });
      expect(icoHead.status).toBe(200);
      expect((await icoHead.arrayBuffer()).byteLength).toBe(0);

      for (const pngPath of ["/icon.png", "/apple-touch-icon.png"]) {
        const png = await fetch(`${base}${pngPath}`);
        expect(png.status, pngPath).toBe(200);
        expect(png.headers.get("content-type")).toContain("image/png");
        const pngBuf = Buffer.from(await png.arrayBuffer());
        expect(pngBuf.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      }

      const svg = await fetch(`${base}/favicon.svg`);
      expect(svg.status).toBe(200);
      expect(svg.headers.get("content-type")).toContain("image/svg+xml");
      expect(await svg.text()).toContain("<svg");
    },
    20_000,
  );

  it(
    "缺少 Authorization 头返回 401，并说明缺什么",
    async () => {
      const error = await connectError(server.mcpUrl);
      expect(error.code).toBe(401);
      expect(error.message).toContain("Authorization");
      expect(error.message).toContain("Bearer");
    },
    20_000,
  );

  it(
    "令牌不正确返回 401",
    async () => {
      const error = await connectError(server.mcpUrl, authInit("wrong-token"));
      expect(error.code).toBe(401);
      expect(error.message).toContain("令牌不正确");
    },
    20_000,
  );

  it(
    "正确令牌放行，令牌不出现在服务日志里",
    async () => {
      const { client, transport } = await connectClient(server.mcpUrl, authInit(TOKEN));
      const { tools } = await client.listTools();
      expect(tools.length).toBe(9);
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
      const first = await connectClient(server.mcpUrl, authInit(TOKEN));
      const second = await connectClient(server.mcpUrl, authInit(TOKEN));

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

      expect(textOf(firstRead)).toContain('"name": "nexus-mcp"');
      expect(textOf(firstRead)).not.toContain('"rootDir": "src"');
      expect(textOf(secondRead)).toContain('"rootDir": "src"');

      // 一个客户端退出不应该影响另一个
      await first.transport.terminateSession();
      await first.client.close();

      const afterClose = await second.client.callTool({
        name: "read",
        arguments: { path: "AGENTS.md" },
      });
      expectOk(afterClose);
      expect(textOf(afterClose)).toContain("9 个工具");

      await second.transport.terminateSession();
      await second.client.close();
    },
    25_000,
  );

  it(
    "会话结束后释放，旧会话 id 不能继续使用",
    async () => {
      const { client, transport } = await connectClient(server.mcpUrl, authInit(TOKEN));
      const sessionId = transport.sessionId as string;
      expect(sessionId).toBeTruthy();

      await transport.terminateSession();
      await client.close();

      const error = await staleSessionError(server.mcpUrl, sessionId);
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
        const { client, transport } = await connectClient(server.mcpUrl, authInit(TOKEN));
        sessionIds.push(transport.sessionId ?? "");
        await transport.terminateSession();
        await client.close();
      }
      expect(new Set(sessionIds).size).toBe(5);

      const { client, transport } = await connectClient(server.mcpUrl, authInit(TOKEN));
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name).sort()).toEqual(ALL_TOOLS);
      await transport.terminateSession();
      await client.close();

      const staleId = sessionIds[0];
      expect(staleId).toBeTruthy();
      const error = await staleSessionError(server.mcpUrl, staleId as string);
      expect(error.code).toBe(404);
      expect(error.message).toContain("会话");
    },
    40_000,
  );
});

describe("HTTP 传输（没有配置令牌）", () => {
  let server: RunningServer;

  beforeAll(async () => {
    server = await startServer();
  }, 30_000);

  afterAll(async () => {
    await server?.stop();
  });

  it(
    "本机客户端不需要令牌就能连上",
    async () => {
      const { client, transport } = await connectClient(server.mcpUrl);
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

  it(
    "未配置令牌时关闭全部 OAuth 端点，且拒绝带隧道/代理转发头的请求绕过本机校验",
    async () => {
      const base = `http://127.0.0.1:${server.port}`;

      for (const [method, endpoint] of [
        ["GET", "/.well-known/oauth-protected-resource"],
        ["GET", "/.well-known/oauth-authorization-server"],
        ["GET", "/oauth/authorize"],
        ["POST", "/oauth/register"],
        ["POST", "/oauth/token"],
      ] as const) {
        const res = await fetch(`${base}${endpoint}`, {
          method,
          headers: method === "POST" ? { "Content-Type": "application/json" } : undefined,
          body:
            method === "POST"
              ? JSON.stringify({ redirect_uris: ["https://example.com/cb"] })
              : undefined,
        });
        expect(res.status, `${method} ${endpoint} 应被拒绝`).toBe(403);
      }

      const proxyCases: Array<Record<string, string>> = [
        { "CF-Connecting-IP": "203.0.113.10" },
        { "X-Forwarded-For": "198.51.100.7" },
      ];
      for (const proxyHeaders of proxyCases) {
        const error = await connectError(server.mcpUrl, {
          requestInit: { headers: proxyHeaders },
        });
        expect(error.code).toBe(403);
      }

      // 非本机 Host 头（模拟 DNS Rebinding 或不注入转发头的 TCP 隧道转发）同样拒绝 403
      const nonLoopbackHostStatus = await new Promise<number>((resolve, reject) => {
        const payload = JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-03-26",
            capabilities: {},
            clientInfo: { name: "rebind-probe", version: "0.1.0" },
          },
        });
        const req = http.request(
          {
            host: "127.0.0.1",
            port: server.port,
            path: "/mcp",
            method: "POST",
            headers: {
              Host: "evil-rebind.example.com",
              "Content-Type": "application/json",
              Accept: "application/json, text/event-stream",
              "Content-Length": Buffer.byteLength(payload),
            },
          },
          (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          },
        );
        req.on("error", reject);
        req.end(payload);
      });
      expect(nonLoopbackHostStatus).toBe(403);
    },
    20_000,
  );

  it(
    "进程重启（热切换）后，未关闭的合法历史 Mcp-Session-Id 透明恢复返回 200，伪造 sid 仍返回 404",
    async () => {
      // 1) 建立正常会话并拿到合法 sessionId（不显式 terminateSession）
      const { client, transport } = await connectClient(server.mcpUrl, {});
      const savedSid = transport.sessionId as string;
      expect(savedSid).toBeTruthy();

      // 2) 通过 /api/shutdown 优雅关闭当前进程（模拟热切换，保留 sessions-store.json）
      const shutdownRes = await fetch(`${server.panelUrl}/api/shutdown`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ includeTunnel: false }),
      });
      expect(shutdownRes.status).toBe(200);
      await new Promise<void>((resolve) => setTimeout(resolve, 400));

      // 3) 用同一份 config.json 拉起新进程（模拟热切换后的新 nexus-server）
      const { spawn } = await import("node:child_process");
      const { projectRoot } = await import("./support/server.js");
      const nextChild = spawn(process.execPath, [path.join(projectRoot, "dist", "index.js")], {
        cwd: projectRoot,
        env: { ...process.env, NEXUS_MCP_CONFIG: server.configPath, NEXUS_TUNNEL_EXTERNAL: "off" },
        stdio: "ignore",
      });
      try {
        const deadline = Date.now() + 10_000;
        let ready = false;
        while (Date.now() < deadline) {
          try {
            const h = await fetch(`http://127.0.0.1:${server.port}/health`);
            if (h.status === 200) {
              ready = true;
              break;
            }
          } catch {
            // retry
          }
          await new Promise((r) => setTimeout(r, 80));
        }
        expect(ready).toBe(true);

        // 4) 直接带着旧 sessionId 调 tools/list，应透明恢复返回 200 而非 404
        const resumed = await fetch(server.mcpUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
            "mcp-session-id": savedSid,
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: 99, method: "tools/list", params: {} }),
        });
        expect(resumed.status).toBe(200);
        const resumedText = await resumed.text();
        expect(resumedText).toContain("read");

        // 5) 伪造未知 sid 仍必须拒绝 404
        const forged = await fetch(server.mcpUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
            "mcp-session-id": "forged-unknown-session-id",
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: 100, method: "tools/list", params: {} }),
        });
        expect(forged.status).toBe(404);
      } finally {
        nextChild.kill();
        await client.close().catch(() => undefined);
      }
    },
    25_000,
  );
});
