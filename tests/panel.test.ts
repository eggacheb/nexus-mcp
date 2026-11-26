import { expectOk } from "./support/tool.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { VERSION } from "../src/version.js";
import { TOOL_SUMMARY } from "../src/tools.js";
import { projectRoot, startServer } from "./support/server.js";
import type { RunningServer } from "./support/server.js";

const TOKEN = "panel-token-8b41d";

interface StatusBody {
  service: { state: string; label: string; port: number; url: string; sessions: number };
  executor: { state: string; label: string; detail?: string };
  tunnel: { state: string; label: string; detail?: string; url?: string };
  root: string;
  version: string;
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

  it("根路径返回分栏页面，日间主题，含目录选择与日志筛选入口", async () => {
    const response = await fetch(server.panelUrl);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    const html = await response.text();

    for (const block of ["status", "address", "tunnel", "root", "settings", "tools", "logs", "controls"]) {
      expect(html).toContain(`data-block="${block}"`);
    }
    // 日间浅色主题：不再声明 dark color-scheme
    expect(html).toContain("color-scheme: light");
    expect(html).not.toContain("color-scheme: dark");
    // 加宽布局与全宽日志
    expect(html).toContain("max-width: 1440px");
    expect(html).toContain('class="card wide" data-block="logs"');
    // 根目录的原生选择按钮与日志筛选框
    expect(html).toContain('id="pick-root"');
    expect(html).toContain('id="log-filter"');
    // 服务重启按钮
    expect(html).toContain('id="restart"');
    // 复制按钮由页面脚本调用剪贴板
    expect(html).toContain("clipboard");
    expect(html).toContain("复制");
  });

  it("面板列出的工具与 MCP 实际注册的一致", async () => {
    const html = await (await fetch(server.panelUrl)).text();
    for (const tool of TOOL_SUMMARY) {
      expect(html).toContain(`<b>${tool.name}</b>`);
    }
    expect(html).not.toContain("写文件，自动建目录");
    expect(html).toContain("不自动建目录");

    const { client, transport } = await connectClient(server.mcpUrl);
    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name).sort()).toEqual(
      TOOL_SUMMARY.map((tool) => tool.name).sort(),
    );
    await transport.terminateSession();
    await client.close();
  });

  it("凭据接口给出公网地址与令牌，状态接口不含令牌", async () => {
    const response = await fetch(`${server.panelUrl}/api/credentials`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      url: string;
      publicUrl: string;
      token: string;
      oauth: { available: boolean };
    };
    expect(body.token).toBe(TOKEN);
    expect(body.url).toBe(`http://127.0.0.1:${server.port}/mcp`);
    // 没配 tunnelUrl 时没有公网地址，面板退回显示本地地址
    expect(body.publicUrl).toBe("");
    expect(body.oauth).toBeTruthy();

    const statusText = JSON.stringify(await getStatus(server));
    expect(statusText).not.toContain(TOKEN);
  });

  it("页面脚本能通过语法解析", async () => {
    const html = await (await fetch(server.panelUrl)).text();
    const script = /<script>([\s\S]*?)<\/script>/.exec(html);
    expect(script).not.toBeNull();
    // 只解析不执行：拦住模板字符串里前端代码的语法错误（字符串断言测不出这个）
    expect(() => new Function(script?.[1] ?? "")).not.toThrow();
  });

  it("版本号可见：页头直接印出，状态接口同源", async () => {
    const status = await getStatus(server);
    expect(status.version).toBe(VERSION);

    // 版本号由服务端直接写进 HTML，不依赖页面脚本渲染
    const html = await (await fetch(server.panelUrl)).text();
    expect(html).toContain('id="app-version"');
    expect(html).toContain(`v${VERSION}`);
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
    // 每行都带 ISO 时间戳，面板按它显示本地时刻并做级别配色
    expect(body.lines[0]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z /);
  });

  it(
    "停止后 MCP 端点不可用、面板仍在线，启动后恢复",
    async () => {
      const before = await connectClient(server.mcpUrl);
      const listed = await before.client.listTools();
      expect(listed.tools.length).toBe(9);
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
      // 注意别用 toBeInstanceOf(Error)：vmThreads 池里 fetch 的异常在主 realm 创建，
      // 和测试文件的 Error 构造器不同 realm，instanceof 会判否（Node 24.12 + vitest 5.1.1）
      expect(refused?.message.length ?? 0).toBeGreaterThan(0);

      const started = await postJson(server, "/api/service", { action: "start" });
      expect(started.status).toBe(200);
      const startedStatus = await getStatus(server);
      expect(startedStatus.service.state).toBe("running");

      const after = await connectClient(server.mcpUrl);
      const relisted = await after.client.listTools();
      expect(relisted.tools.length).toBe(9);
      await after.transport.terminateSession();
      await after.client.close();
    },
    40_000,
  );

  it(
    "重启服务：旧会话作废、端点恢复，面板不掉线",
    async () => {
      const before = await connectClient(server.mcpUrl);
      expect(before.transport.sessionId).toBeTruthy();

      const response = await postJson(server, "/api/service", { action: "restart" });
      expect(response.status).toBe(200);
      const status = (await response.json()) as StatusBody;
      expect(status.service.state).toBe("running");

      // 面板自己还在
      expect((await fetch(server.panelUrl)).status).toBe(200);

      // 旧会话被断开
      const stale = await before.client.listTools().then(
        () => null,
        (error: unknown) => error as Error,
      );
      expect(stale).toBeTruthy();

      // 新会话照常工作
      const after = await connectClient(server.mcpUrl);
      const relisted = await after.client.listTools();
      expect(relisted.tools.length).toBe(9);
      await after.transport.terminateSession();
      await after.client.close();
      await before.client.close();
    },
    40_000,
  );

  it(
    "普通会话断开保留后台任务，面板停止或重启服务则关闭执行器并树杀后台任务",
    async () => {
      const isPidAlive = (pid: number): boolean => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      };

      const first = await connectClient(server.mcpUrl);
      const startedJob = (await first.client.callTool({
        name: "job_start",
        arguments: { command: "sleep 30" },
      })) as { content: Array<{ type: string; text: string }>; isError?: boolean };
      expectOk(startedJob);
      const startText = startedJob.content[0]?.text ?? "";
      const jobId = /job-\d+/.exec(startText)?.[0] ?? "";
      const pid = Number(/pid (\d+)/.exec(startText)?.[1] ?? "0");
      expect(jobId).toMatch(/^job-\d+$/);
      expect(pid).toBeGreaterThan(0);
      expect(isPidAlive(pid)).toBe(true);

      // 1) 普通会话断开：后台任务不受影响，新会话仍能查到 running
      await first.transport.terminateSession();
      await first.client.close();

      const second = await connectClient(server.mcpUrl);
      const stillRunning = (await second.client.callTool({
        name: "job_output",
        arguments: { job_id: jobId },
      })) as { content: Array<{ type: string; text: string }>; isError?: boolean };
      expectOk(stillRunning);
      expect(stillRunning.content[0]?.text ?? "").toContain("status: running");
      await second.transport.terminateSession();
      await second.client.close();

      // 2) 面板停止服务：关闭执行器并树杀后台任务
      const stopped = await postJson(server, "/api/service", { action: "stop" });
      expect(stopped.status).toBe(200);

      const deadline = Date.now() + 8_000;
      while (isPidAlive(pid) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(isPidAlive(pid)).toBe(false);

      // 重新启动服务后，旧后台任务记录已随旧执行器清空
      const restarted = await postJson(server, "/api/service", { action: "start" });
      expect(restarted.status).toBe(200);

      const third = await connectClient(server.mcpUrl);
      const gone = (await third.client.callTool({
        name: "job_output",
        arguments: { job_id: jobId },
      })) as { content: Array<{ type: string; text: string }>; isError?: boolean };
      expect(gone.isError).toBe(true);
      expect(gone.content[0]?.text ?? "").toContain("不存在");
      await third.transport.terminateSession();
      await third.client.close();
    },
    45_000,
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

        // 重载真的重启了端点：旧会话不再可用（不用 toBeInstanceOf，避免 vmThreads 跨 realm 假阴性）
        const stale = await client.listTools().then(
          () => null,
          (error: unknown) => error as Error,
        );
        expect(stale?.message.length ?? 0).toBeGreaterThan(0);
      } finally {
        writeFileSync(server.configPath, original, "utf8");
        await postJson(server, "/api/service", { action: "reload" });
        rmSync(altRoot, { recursive: true, force: true });
        await client.close();
      }
    },
    40_000,
  );

  it(
    "重载配置校验与快捷设置同严，且清除已删可选字段并同步 TunnelManager",
    async () => {
      const original = readFileSync(server.configPath, "utf8");
      const base = JSON.parse(original) as Record<string, unknown>;

      try {
        // 1) loadConfig 严格校验：未知 shell / 非正整数 / 含空白 tunnelUrl 重载必须报错拒绝
        for (const badPatch of [
          { shell: "cmd" },
          { maxOutputBytes: 0 },
          { defaultTimeoutMs: -10 },
          { tunnelUrl: "https://has space.example" },
        ]) {
          writeFileSync(server.configPath, JSON.stringify({ ...base, ...badPatch }, null, 2), "utf8");
          const rejected = await postJson(server, "/api/service", { action: "reload" });
          expect(rejected.status).toBe(500);
        }

        // 2) 动态加上 tunnelUrl 与 tunnel 段后重载：TunnelManager 同步启用
        writeFileSync(
          server.configPath,
          JSON.stringify(
            {
              ...base,
              tunnelUrl: "https://reload-sync.example.test",
              tunnel: {
                cloudflaredPath: path.join(projectRoot, "nonexistent-cloudflared.exe"),
                configPath: path.join(projectRoot, "package.json"),
                metricsPort: 1,
              },
            },
            null,
            2,
          ),
          "utf8",
        );
        const enabled = await postJson(server, "/api/service", { action: "reload" });
        expect(enabled.status).toBe(200);
        const withTunnel = await getStatus(server);
        expect(withTunnel.tunnel.url).toBe("https://reload-sync.example.test");
        expect(withTunnel.tunnel.state).toBe("unavailable");

        // 3) 从 config.json 删除 tunnelUrl 与 tunnel 后重载：无字段残留，回到 unconfigured
        writeFileSync(server.configPath, original, "utf8");
        const cleared = await postJson(server, "/api/service", { action: "reload" });
        expect(cleared.status).toBe(200);
        const afterClear = await getStatus(server);
        expect(afterClear.tunnel.url).toBeUndefined();
        expect(afterClear.tunnel.state).toBe("unconfigured");
      } finally {
        writeFileSync(server.configPath, original, "utf8");
        await postJson(server, "/api/service", { action: "reload" });
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
        expectOk(inside);

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

describe("只配 tunnelUrl 的部署", () => {
  let server: RunningServer;

  beforeAll(async () => {
    // 故意指向一个没人监听的回环端口：如果面板还拿公网往返点灯，这里就会是红的
    server = await startServer({ token: TOKEN, tunnelUrl: "http://127.0.0.1:9/" });
  }, 30_000);

  afterAll(async () => {
    await server?.stop();
  });

  it("没有 tunnel 段就不点灯：只保留公网地址，标未启用管理", async () => {
    const status = await getStatus(server);
    expect(status.tunnel.url).toBe("http://127.0.0.1:9/");
    expect(status.tunnel.state).toBe("unconfigured");
    expect(status.tunnel.label).toBe("未启用管理");
  });
});

describe("隧道状态以 cloudflared 就绪连接为准", () => {
  let server: RunningServer;
  let fakeMetrics: http.Server;
  let readyConnections = 3;

  beforeAll(async () => {
    fakeMetrics = http.createServer((req, res) => {
      if (req.url === "/ready") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: 200, readyConnections }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => fakeMetrics.listen(0, "127.0.0.1", () => resolve()));
    const address = fakeMetrics.address();
    const metricsPort = typeof address === "object" && address ? address.port : 0;

    // 公网地址故意指向关闭的端口：任何公网探测都会立刻失败。
    // 状态灯若还跟着它走，这里就永远是红的。
    server = await startServer({
      token: TOKEN,
      tunnelUrl: "http://127.0.0.1:1/",
      tunnel: {
        cloudflaredPath: path.join(projectRoot, "package.json"),
        configPath: path.join(projectRoot, "package.json"),
        metricsPort,
      },
    });
  }, 30_000);

  afterAll(async () => {
    await server?.stop();
    await new Promise<void>((resolve) => {
      if (!fakeMetrics.listening) {
        resolve();
        return;
      }
      fakeMetrics.close(() => resolve());
    });
  });

  it(
    "公网探测打不通，但就绪连接在，仍报在线",
    async () => {
      readyConnections = 3;
      const status = await getStatus(server);
      expect(status.tunnel.state).toBe("up");
      expect(status.tunnel.label).toBe("在线");
      expect(status.tunnel.detail ?? "").toContain("3");
    },
    20_000,
  );

  it(
    "就绪连接掉到 0 报连接中，不是在线",
    async () => {
      readyConnections = 0;
      const status = await getStatus(server);
      expect(status.tunnel.state).toBe("connecting");
      expect(status.tunnel.label).toBe("连接中");
    },
    20_000,
  );
});

describe("快捷设置", () => {
  let server: RunningServer;

  interface SettingsBody {
    shell: string;
    maxOutputBytes: number;
    defaultTimeoutMs: number;
    tunnelUrl?: string;
    commandPolicy: { allow: string[]; deny: string[]; onUnmatched: string };
  }

  async function getSettings(): Promise<SettingsBody> {
    const response = await fetch(`${server.panelUrl}/api/settings`);
    expect(response.status).toBe(200);
    return (await response.json()) as SettingsBody;
  }

  beforeAll(async () => {
    server = await startServer({ token: TOKEN });
  }, 30_000);

  afterAll(async () => {
    await server?.stop();
  });

  it("GET /api/settings 返回当前可编辑的配置值", async () => {
    const settings = await getSettings();
    expect(settings.shell).toBe("auto");
    expect(settings.maxOutputBytes).toBe(64 * 1024);
    expect(settings.defaultTimeoutMs).toBe(120_000);
    expect(settings.tunnelUrl ?? "").toBe("");
    expect(settings.commandPolicy).toEqual({ allow: [], deny: [], onUnmatched: "deny" });
  });

  it(
    "POST /api/settings 保存后立即生效并写回 config.json",
    async () => {
      const saved = await postJson(server, "/api/settings", {
        maxOutputBytes: 32 * 1024,
        defaultTimeoutMs: 60_000,
        tunnelUrl: "https://nexus.example.test/",
        commandPolicy: { allow: ["git *"], deny: ["git push --force*"], onUnmatched: "deny" },
      });
      expect(saved.status).toBe(200);

      const settings = await getSettings();
      expect(settings.maxOutputBytes).toBe(32 * 1024);
      expect(settings.defaultTimeoutMs).toBe(60_000);
      expect(settings.tunnelUrl).toBe("https://nexus.example.test/");
      expect(settings.commandPolicy).toEqual({
        allow: ["git *"],
        deny: ["git push --force*"],
        onUnmatched: "deny",
      });

      const disk = JSON.parse(readFileSync(server.configPath, "utf8")) as Record<string, unknown>;
      expect(disk.maxOutputBytes).toBe(32 * 1024);
      expect(disk.defaultTimeoutMs).toBe(60_000);
      expect(disk.tunnelUrl).toBe("https://nexus.example.test/");
      expect(disk.commandPolicy).toEqual({
        allow: ["git *"],
        deny: ["git push --force*"],
        onUnmatched: "deny",
      });

      // tunnelUrl 留空 = 清除，磁盘上也不留这个键
      const cleared = await postJson(server, "/api/settings", { tunnelUrl: "" });
      expect(cleared.status).toBe(200);
      expect((await getSettings()).tunnelUrl ?? "").toBe("");
      const clearedDisk = JSON.parse(readFileSync(server.configPath, "utf8")) as Record<string, unknown>;
      expect(clearedDisk.tunnelUrl).toBeUndefined();

      // 闸门新配置对运行中的服务立即生效：白名单没接住的 bash 直接被拒，不用重启
      const { client, transport } = await connectClient(server.mcpUrl);
      const blocked = await client.callTool({ name: "bash", arguments: { command: "echo hi" } });
      expect(blocked.isError).toBe(true);
      expect(JSON.stringify(blocked)).toContain("白名单");
      await transport.terminateSession();
      await client.close();
    },
    30_000,
  );

  it("shell 换成 pwsh：保存后接口返回新值（不牵涉命令执行）", async () => {
    const response = await postJson(server, "/api/settings", { shell: "pwsh" });
    expect(response.status).toBe(200);
    expect((await getSettings()).shell).toBe("pwsh");

    const disk = JSON.parse(readFileSync(server.configPath, "utf8")) as { shell: string };
    expect(disk.shell).toBe("pwsh");
  });

  it("非法输入一律 400，config.json 原样不动", async () => {
    const before = readFileSync(server.configPath, "utf8");
    const cases: Array<[string, Record<string, unknown>]> = [
      ["shell 是 5.1", { shell: "powershell" }],
      ["shell 未知值", { shell: "cmd" }],
      ["maxOutputBytes 为 0", { maxOutputBytes: 0 }],
      ["maxOutputBytes 是小数", { maxOutputBytes: 1.5 }],
      ["defaultTimeoutMs 为负", { defaultTimeoutMs: -1 }],
      ["tunnelUrl 类型不对", { tunnelUrl: 123 }],
      ["commandPolicy.allow 不是数组", { commandPolicy: { allow: "git *" } }],
      ["onUnmatched 非法", { commandPolicy: { onUnmatched: "maybe" } }],
    ];
    for (const [label, body] of cases) {
      const response = await postJson(server, "/api/settings", body);
      expect(response.status, label).toBe(400);
    }
    expect(readFileSync(server.configPath, "utf8")).toBe(before);
  });
});
