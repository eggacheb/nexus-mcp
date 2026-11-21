import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { projectRoot, startServer } from "./support/server.js";
import type { RunningServer } from "./support/server.js";

const TOKEN = "panel-token-8b41d";

interface StatusBody {
  service: { state: string; label: string; port: number; url: string; sessions: number };
  executor: { state: string; label: string; detail?: string };
  tunnel: { state: string; label: string; detail?: string };
  root: string;
  oauth: { url: string; available: boolean };
}

async function getStatus(server: RunningServer): Promise<StatusBody> {
  const response = await fetch(`${server.panelUrl}/api/status`);
  expect(response.status).toBe(200);
  return (await response.json()) as StatusBody;
}

async function postJson(
  server: RunningServer,
  pathname: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${server.panelUrl}${pathname}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function rawGet(port: number, pathname: string, hostHeader: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      { host: "127.0.0.1", port, path: pathname, method: "GET", headers: { Host: hostHeader } },
      (response) => {
        response.resume();
        response.on("end", () => resolve(response.statusCode ?? 0));
      },
    );
    request.on("error", reject);
    request.end();
  });
}

async function connectClient(url: URL): Promise<{ client: Client; transport: StreamableHTTPClientTransport }> {
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
  });
  const client = new Client({ name: "vitest-panel", version: "0.1.0" });
  await client.connect(transport);
  return { client, transport };
}

describe("本地控制面板", () => {
  let server: RunningServer;

  beforeAll(async () => {
    server = await startServer({ token: TOKEN });
  }, 30_000);

  afterAll(async () => {
    await server?.stop();
  });

  it("根路径返回一屏六块的页面", async () => {
    const response = await fetch(server.panelUrl);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    const html = await response.text();

    for (const block of ["status", "address", "oauth", "root", "logs", "controls"]) {
      expect(html).toContain(`data-block="${block}"`);
    }
    // 复制按钮由页面脚本调用剪贴板
    expect(html).toContain("clipboard");
    expect(html).toContain("复制");
  });

  it(
    "状态灯来自真实探测，不是写死的",
    async () => {
      const status = await getStatus(server);
      expect(status.service.state).toBe("running");
      expect(status.service.port).toBe(server.port);
      expect(status.service.url).toBe(`http://127.0.0.1:${server.port}/mcp`);
      // 执行器已接入，状态灯来自真实 ping 握手，应在线
      expect(status.executor.state).toBe("up");
      // 没配 tunnelUrl，隧道显示未配置
      expect(status.tunnel.state).toBe("unconfigured");
      expect(status.root).toBe(projectRoot);
      expect(JSON.stringify(status)).not.toContain(TOKEN);
    },
    20_000,
  );

  it("日志接口返回最近的行，且不泄露令牌", async () => {
    const response = await fetch(`${server.panelUrl}/api/logs`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { lines: string[] };
    expect(Array.isArray(body.lines)).toBe(true);
    expect(body.lines.length).toBeGreaterThan(0);
    expect(body.lines.length).toBeLessThanOrEqual(100);
    expect(body.lines.join("\n")).not.toContain(TOKEN);
  });

  it(
    "停止后 MCP 端点不可用、面板仍在线，启动后恢复",
    async () => {
      const before = await connectClient(server.mcpUrl);
      const listed = await before.client.listTools();
      expect(listed.tools.length).toBe(8);
      await before.transport.terminateSession();
      await before.client.close();

      const stopped = await postJson(server, "/api/service", { action: "stop" });
      expect(stopped.status).toBe(200);
      const stoppedStatus = await getStatus(server);
      expect(stoppedStatus.service.state).toBe("stopped");

      // 面板自己还活着
      const panelStillUp = await fetch(server.panelUrl);
      expect(panelStillUp.status).toBe(200);

      // MCP 端点已经关了
      const refused = await fetch(server.mcpUrl, { method: "POST" }).then(
        () => null,
        (error: unknown) => error as Error,
      );
      expect(refused).toBeInstanceOf(Error);

      const started = await postJson(server, "/api/service", { action: "start" });
      expect(started.status).toBe(200);
      const startedStatus = await getStatus(server);
      expect(startedStatus.service.state).toBe("running");

      const after = await connectClient(server.mcpUrl);
      const relisted = await after.client.listTools();
      expect(relisted.tools.length).toBe(8);
      await after.transport.terminateSession();
      await after.client.close();
    },
    40_000,
  );

  it(
    "重载配置把磁盘上的改动带进运行中的服务",
    async () => {
      const before = await getStatus(server);
      const original = readFileSync(server.configPath, "utf8");
      const altRoot = mkdtempSync(path.join(os.tmpdir(), "nexus-mcp-reload-"));
      const config = JSON.parse(original) as Record<string, unknown>;

      const { client, transport } = await connectClient(server.mcpUrl);
      expect(transport.sessionId).toBeTruthy();

      try {
        // 模拟用户直接改 config.json，再点重载
        writeFileSync(
          server.configPath,
          JSON.stringify({ ...config, root: altRoot }, null, 2),
          "utf8",
        );

        const reloaded = await postJson(server, "/api/service", { action: "reload" });
        expect(reloaded.status).toBe(200);

        const after = await getStatus(server);
        expect(after.service.state).toBe("running");
        expect(after.root).toBe(path.resolve(altRoot));
        expect(after.root).not.toBe(before.root);

        // 重载真的重启了端点：旧会话不再可用
        const stale = await client.listTools().then(
          () => null,
          (error: unknown) => error as Error,
        );
        expect(stale).toBeInstanceOf(Error);
      } finally {
        writeFileSync(server.configPath, original, "utf8");
        await postJson(server, "/api/service", { action: "reload" });
        rmSync(altRoot, { recursive: true, force: true });
        await client.close();
      }
    },
    40_000,
  );

  it("拒绝跨站写操作", async () => {
    const crossSite = await postJson(
      server,
      "/api/root",
      { root: os.tmpdir() },
      { Origin: "https://evil.example" },
    );
    expect(crossSite.status).toBe(403);

    const crossSiteService = await postJson(
      server,
      "/api/service",
      { action: "stop" },
      { Origin: "https://evil.example" },
    );
    expect(crossSiteService.status).toBe(403);
    expect((await getStatus(server)).service.state).toBe("running");

    // 表单式 POST（简单请求，浏览器不会预检）也不该被接受
    const formPost = await fetch(`${server.panelUrl}/api/root`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "root=C:/",
    });
    expect(formPost.status).toBe(415);

    // 换了 Host 的请求（DNS rebinding 的路子）一律拒绝
    const rebound = await rawGet(server.panelPort, "/api/logs", "evil.example");
    expect(rebound).toBe(403);

    const status = await getStatus(server);
    expect(status.root).toBe(projectRoot);
  });

  it(
    "改根目录后立即生效并写回配置文件",
    async () => {
      const newRoot = mkdtempSync(path.join(os.tmpdir(), "nexus-mcp-root-"));
      const file = path.join(newRoot, "hello.txt");
      writeFileSync(file, "hi\n", "utf8");

      try {
        const missing = await postJson(server, "/api/root", {
          root: path.join(os.tmpdir(), "nexus-mcp-missing-root-9d3"),
        });
        expect(missing.status).toBe(400);

        const relative = await postJson(server, "/api/root", { root: "some/relative/dir" });
        expect(relative.status).toBe(400);

        const response = await postJson(server, "/api/root", { root: newRoot });
        expect(response.status).toBe(200);

        const status = await getStatus(server);
        expect(status.root).toBe(path.resolve(newRoot));

        const saved = JSON.parse(readFileSync(server.configPath, "utf8")) as { root: string };
        expect(path.resolve(saved.root)).toBe(path.resolve(newRoot));

        const { client, transport } = await connectClient(server.mcpUrl);
        const inside = await client.callTool({ name: "read", arguments: { path: file } });
        expect(inside.isError).toBeFalsy();

        const outside = await client.callTool({
          name: "read",
          arguments: { path: path.join(projectRoot, "package.json") },
        });
        expect(outside.isError).toBe(true);

        await transport.terminateSession();
        await client.close();
      } finally {
        await postJson(server, "/api/root", { root: projectRoot });
        rmSync(newRoot, { recursive: true, force: true });
      }
    },
    30_000,
  );
});

describe("隧道状态来自真实探测", () => {
  let server: RunningServer;
  const fakeTunnel = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ok");
  });

  beforeAll(async () => {
    await new Promise<void>((resolve) => fakeTunnel.listen(0, "127.0.0.1", () => resolve()));
    const address = fakeTunnel.address();
    const tunnelPort = typeof address === "object" && address ? address.port : 0;
    server = await startServer({
      token: TOKEN,
      tunnelUrl: `http://127.0.0.1:${tunnelPort}/`,
    });
  }, 30_000);

  afterAll(async () => {
    await server?.stop();
    if (fakeTunnel.listening) {
      await new Promise<void>((resolve) => fakeTunnel.close(() => resolve()));
    }
  });

  it(
    "配了 tunnelUrl 就真去探，断了就变成离线",
    async () => {
      const up = await getStatus(server);
      expect(up.tunnel.state).toBe("up");

      await new Promise<void>((resolve) => fakeTunnel.close(() => resolve()));

      const down = await getStatus(server);
      expect(down.tunnel.state).toBe("down");
      expect(down.tunnel.label).toBe("离线");
    },
    25_000,
  );
});
