import crypto from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it } from "vitest";
import { TunnelManager } from "../src/tunnel.js";
import { configureLogger, recentLogs } from "../src/log.js";
import { startServer } from "./support/server.js";
import { expectOk } from "./support/tool.js";

const tempDirs: string[] = [];
function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

function readDiskLogText(configPath: string): string {
  const logDir = path.join(path.dirname(configPath), "logs");
  expect(existsSync(logDir)).toBe(true);
  const files = readdirSync(logDir).filter((f) => /^nexus-mcp-\d{4}-\d{2}-\d{2}\.log$/.test(f));
  expect(files.length).toBeGreaterThan(0);
  return files.map((f) => readFileSync(path.join(logDir, f), "utf8")).join("\n");
}

function rawHttpRequest(
  port: number,
  options: { method?: string; pathname: string; headers?: Record<string, string>; body?: string },
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: options.pathname,
        method: options.method ?? "POST",
        headers: options.headers ?? {},
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          data += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
      },
    );
    req.on("error", reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

describe("票 15.1：鉴权拒绝、OAuth 2.1 与会话生命周期日志", () => {
  it(
    "401 / 403 鉴权拒绝写入 WARN auth.deny，且不泄露令牌原文与 authorization 字样",
    async () => {
      const token = "auth-secret-tok-1501";
      const wrongToken = "wrong-secret-tok-9999";
      const authed = await startServer({ token });
      try {
        // 1. 缺少凭据 -> 401
        const r1 = await fetch(authed.mcpUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        });
        expect(r1.status).toBe(401);

        // 2. 非 Bearer 格式 -> 401
        const r2 = await fetch(authed.mcpUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Basic ${wrongToken}` },
          body: "{}",
        });
        expect(r2.status).toBe(401);

        // 3. 错误 Bearer 令牌 -> 401
        const r3 = await fetch(authed.mcpUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${wrongToken}` },
          body: "{}",
        });
        expect(r3.status).toBe(401);

        const disk = readDiskLogText(authed.configPath);
        const panelLogs = ((await (await fetch(`${authed.panelUrl}/api/logs`)).json()) as { lines: string[] }).lines.join("\n");
        const stderr = authed.stderrText();

        for (const text of [disk, panelLogs, stderr]) {
          expect(text).toContain("[WARN] [auth.deny] status=401 reason=missing_credentials");
          expect(text).toContain("[WARN] [auth.deny] status=401 reason=invalid_scheme");
          expect(text).toContain("[WARN] [auth.deny] status=401 reason=invalid_token");
          expect(text).not.toContain(token);
          expect(text).not.toContain(wrongToken);
          expect(text.toLowerCase()).not.toContain("authorization");
        }
      } finally {
        await authed.stop();
      }

      // 空令牌模式：代理转发头与非本机 Host 头触发 403
      const openServer = await startServer({ token: "" });
      try {
        const proxyRes = await rawHttpRequest(openServer.port, {
          pathname: "/mcp",
          headers: {
            Host: `127.0.0.1:${openServer.port}`,
            "Content-Type": "application/json",
            "X-Forwarded-For": "203.0.113.5",
          },
          body: "{}",
        });
        expect(proxyRes.status).toBe(403);

        const hostRes = await rawHttpRequest(openServer.port, {
          pathname: "/mcp",
          headers: {
            Host: "evil.example.com",
            "Content-Type": "application/json",
          },
          body: "{}",
        });
        expect(hostRes.status).toBe(403);

        const disk = readDiskLogText(openServer.configPath);
        expect(disk).toContain("[WARN] [auth.deny] status=403 reason=proxy_header");
        expect(disk).toContain("[WARN] [auth.deny] status=403 reason=invalid_host");
        expect(disk.toLowerCase()).not.toContain("authorization");
      } finally {
        await openServer.stop();
      }
    },
    30_000,
  );

  it(
    "OAuth 2.1 动态注册、授权批准/口令拒绝、签发令牌与刷新失败均记录日志且零密钥泄漏",
    async () => {
      const token = "oauth-approve-secret-7712";
      const server = await startServer({ token });
      const base = `http://127.0.0.1:${server.port}`;

      try {
        // 1. 动态注册
        const regRes = await fetch(`${base}/oauth/register`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            client_name: "TestConnector",
            redirect_uris: ["https://example.com/cb"],
            token_endpoint_auth_method: "client_secret_post",
          }),
        });
        expect(regRes.status).toBe(201);
        const reg = (await regRes.json()) as { client_id: string; client_secret: string };

        const verifier = "verifier-string-for-pkce-s256-check-1234567890abcdef";
        const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");

        // 2. 授权页口令错误拒绝 -> 401
        const badApprove = await fetch(`${base}/oauth/authorize`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            client_id: reg.client_id,
            redirect_uri: "https://example.com/cb",
            response_type: "code",
            code_challenge: challenge,
            code_challenge_method: "S256",
            action: "approve",
            approval_token: "wrong-approval-pass",
          }),
          redirect: "manual",
        });
        expect(badApprove.status).toBe(401);

        // 3. 授权页批准 -> 302 带 code
        const goodApprove = await fetch(`${base}/oauth/authorize`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            client_id: reg.client_id,
            redirect_uri: "https://example.com/cb",
            response_type: "code",
            code_challenge: challenge,
            code_challenge_method: "S256",
            action: "approve",
            approval_token: token,
          }),
          redirect: "manual",
        });
        expect(goodApprove.status).toBe(302);
        const loc = new URL(goodApprove.headers.get("location") ?? "");
        const code = loc.searchParams.get("code") ?? "";
        expect(code).toBeTruthy();

        // 4. 换取访问令牌 -> 200
        const tokRes = await fetch(`${base}/oauth/token`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "authorization_code",
            client_id: reg.client_id,
            client_secret: reg.client_secret,
            code,
            redirect_uri: "https://example.com/cb",
            code_verifier: verifier,
          }),
        });
        expect(tokRes.status).toBe(200);
        const tok = (await tokRes.json()) as { access_token: string; refresh_token: string };

        // 5. 刷新失败 -> 400
        const badRefresh = await fetch(`${base}/oauth/token`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "refresh_token",
            client_id: reg.client_id,
            client_secret: reg.client_secret,
            refresh_token: "nexus_rt_invalid_refresh_token_xyz",
          }),
        });
        expect(badRefresh.status).toBe(400);

        const disk = readDiskLogText(server.configPath);
        expect(disk).toContain(`[INFO] [oauth.register]`);
        expect(disk).toContain(`[WARN] [oauth.authorize.reject]`);
        expect(disk).toContain(`[INFO] [oauth.authorize.approve]`);
        expect(disk).toContain(`[INFO] [oauth.token.issue]`);
        expect(disk).toContain(`[WARN] [oauth.token.fail]`);

        // 严禁泄露任何敏感凭据
        expect(disk).not.toContain(token);
        expect(disk).not.toContain("wrong-approval-pass");
        expect(disk).not.toContain(reg.client_secret);
        expect(disk).not.toContain(code);
        expect(disk).not.toContain(tok.access_token);
        expect(disk).not.toContain(tok.refresh_token);
        expect(disk).not.toContain("nexus_rt_invalid_refresh_token_xyz");
        expect(disk.toLowerCase()).not.toContain("authorization");
      } finally {
        await server.stop();
      }
    },
    30_000,
  );

  it(
    "会话建立/关闭记 INFO、未知 sid 触发 404 记 WARN，debug 级别记录控制请求与 SSE 开闭",
    async () => {
      const server = await startServer({ logLevel: "debug" });
      const transport = new StreamableHTTPClientTransport(server.mcpUrl);
      const client = new Client({ name: "vitest-session-obs", version: "0.1.0" });

      try {
        await client.connect(transport);
        const fullSid = transport.sessionId ?? "";
        const shortSid = fullSid.slice(0, 8);
        expect(shortSid).toHaveLength(8);

        await client.listTools();

        // 携带未知 sessionId 发请求 -> 404
        const staleSid = "deadbeef-0000-0000-0000-000000000000";
        const staleRes = await fetch(server.mcpUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Mcp-Session-Id": staleSid,
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
        });
        expect(staleRes.status).toBe(404);

        await transport.terminateSession();
        await client.close();
        // 给关闭回调一点时间落盘
        await new Promise((r) => setTimeout(r, 150));

        const disk = readDiskLogText(server.configPath);
        expect(disk).toContain(`[INFO] [session.open] sid=${shortSid} active=1`);
        expect(disk).toContain(`[INFO] [session.close] sid=${shortSid}`);
        expect(disk).toContain(`[WARN] [session.not_found] sid=deadbeef`);
        expect(disk).toContain(`[DEBUG] [mcp.rpc]`);
        expect(disk).toContain(`method=initialize`);
        expect(disk).toContain(`method=tools/list`);
        expect(disk).toContain(`[DEBUG] [sse.open] sid=${shortSid}`);
        expect(disk).toContain(`[DEBUG] [sse.close] sid=${shortSid}`);
      } finally {
        await client.close().catch(() => {});
        await server.stop();
      }
    },
    30_000,
  );
});

describe("票 15.2 & 15.3：管控事件日志、只读接口零刷屏、面板 logLevel 热切换与四级着色", () => {
  it(
    "面板所有只读 GET 与 /health 保持零服务日志输出，写操作与隧道探测产出结构化管控日志",
    async () => {
      const server = await startServer({ logLevel: "debug" });
      try {
        // 等服务启动期最后一条 service.ready 落盘后再取基线，避免启动竞态
        const readyDeadline = Date.now() + 3_000;
        while (Date.now() < readyDeadline) {
          if (readDiskLogText(server.configPath).includes("[INFO] [service.ready]")) break;
          await new Promise((r) => setTimeout(r, 20));
        }
        const beforeLines = readDiskLogText(server.configPath).trim().split("\n");

        // 连续访问全部只读 GET 接口与 /health
        expect((await fetch(`http://127.0.0.1:${server.port}/health`)).status).toBe(200);
        expect((await fetch(`${server.panelUrl}/`)).status).toBe(200);
        expect((await fetch(`${server.panelUrl}/api/status`)).status).toBe(200);
        expect((await fetch(`${server.panelUrl}/api/logs`)).status).toBe(200);
        expect((await fetch(`${server.panelUrl}/api/credentials`)).status).toBe(200);
        expect((await fetch(`${server.panelUrl}/api/settings`)).status).toBe(200);

        const afterReadOnly = readDiskLogText(server.configPath).trim().split("\n");
        expect(afterReadOnly).toEqual(beforeLines);

        // 执行面板管控操作：停止、启动、重载配置
        const postPanel = (pathname: string, body: unknown) =>
          fetch(`${server.panelUrl}${pathname}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          });

        expect((await postPanel("/api/service", { action: "stop" })).status).toBe(200);
        expect((await postPanel("/api/service", { action: "start" })).status).toBe(200);
        expect((await postPanel("/api/service", { action: "reload" })).status).toBe(200);

        const disk = readDiskLogText(server.configPath);
        expect(disk).toContain("[INFO] [panel.ready]");
        expect(disk).toContain("[INFO] [panel.service] action=stop");
        expect(disk).toContain("[INFO] [panel.service] action=start");
        expect(disk).toContain("[INFO] [panel.service] action=reload");
      } finally {
        await server.stop();
      }
    },
    30_000,
  );

  it(
    "隧道守护异常退出记 WARN、自动重启失败记 ERROR",
    async () => {
      const dir = makeTempDir("nexus-tunnel-obs-");
      const stubPath = path.join(dir, "stub.mjs");
      const cfgPath = path.join(dir, "tunnel.yml");
      const logfilePath = path.join(dir, "cloudflared.log");
      writeFileSync(cfgPath, "tunnel: fake\n", "utf8");
      // 立刻以退出码 2 退出的假隧道
      writeFileSync(stubPath, "process.exit(2);\n", "utf8");

      configureLogger({ level: "info", logDir: null, writeStderr: () => {}, resetRing: true });
      const manager = new TunnelManager({
        cloudflaredPath: process.execPath,
        configPath: cfgPath,
        logfilePath,
        autoRestart: true,
        restartDelayMs: 80,
        argsPrefix: [stubPath],
        isRunningExternal: async () => false,
      });

      try {
        await manager.start();
        // 删除配置文件让自动重启失败，轮询等待异步退出与自动重启日志收敛
        rmSync(cfgPath, { force: true });
        const deadline = Date.now() + 5_000;
        while (Date.now() < deadline) {
          if (recentLogs().join("\n").includes("[ERROR] [tunnel.restart_failed]")) break;
          await new Promise((r) => setTimeout(r, 30));
        }

        const logs = recentLogs().join("\n");
        expect(logs).toContain("[INFO] [tunnel.start]");
        expect(logs).toContain("[WARN] [tunnel.exit]");
        expect(logs).toContain("[ERROR] [tunnel.restart_failed]");
      } finally {
        await manager.stopManaged();
        configureLogger({ level: "info", logDir: null, resetRing: true });
      }
    },
    15_000,
  );

  it(
    "面板快捷设置支持免重启热切换 logLevel（不断开现有 MCP 会话），且前端支持四级着色与筛选",
    async () => {
      const sandboxDir = makeTempDir("nexus-panel-lvl-");
      writeFileSync(path.join(sandboxDir, "demo.txt"), "hello\n", "utf8");
      const server = await startServer({ root: sandboxDir, logLevel: "info" });
      const transport = new StreamableHTTPClientTransport(server.mcpUrl);
      const client = new Client({ name: "vitest-panel-lvl", version: "0.1.0" });

      try {
        // 1. 前端 HTML 包含 set-log-level 下拉与 lv-debug 样式，且脚本语法有效
        const html = await (await fetch(server.panelUrl)).text();
        expect(html).toContain('id="set-log-level"');
        expect(html).toContain("lv-debug");
        expect(html).toContain("[DEBUG]");
        const script = /<script>([\s\S]*?)<\/script>/.exec(html);
        expect(() => new Function(script?.[1] ?? "")).not.toThrow();

        // 2. GET /api/settings 返回当前 logLevel
        const s1 = (await (await fetch(`${server.panelUrl}/api/settings`)).json()) as {
          logLevel?: string;
        };
        expect(s1.logLevel).toBe("info");

        // 3. 建立 MCP 会话并在 info 下调 read（不应出现 DEBUG）
        await client.connect(transport);
        const sidBefore = transport.sessionId;
        expect(sidBefore).toBeTruthy();

        expectOk(await client.callTool({ name: "read", arguments: { path: "demo.txt" } }));
        expect(readDiskLogText(server.configPath)).not.toContain("[DEBUG] [tool.start]");

        // 4. POST /api/settings 非法 logLevel 返回 400
        const badRes = await fetch(`${server.panelUrl}/api/settings`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ logLevel: "noisy" }),
        });
        expect(badRes.status).toBe(400);

        // 5. POST /api/settings 热切到 debug，写回 config.json，且同一 MCP 会话不断开立即生效
        const okRes = await fetch(`${server.panelUrl}/api/settings`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ logLevel: "debug" }),
        });
        expect(okRes.status).toBe(200);
        const okBody = (await okRes.json()) as { settings?: { logLevel?: string } };
        expect(okBody.settings?.logLevel).toBe("debug");

        const savedCfg = JSON.parse(readFileSync(server.configPath, "utf8")) as { logLevel?: string };
        expect(savedCfg.logLevel).toBe("debug");

        // 沿用同一个未断开的 MCP 会话再次调 read -> 立刻出现 DEBUG tool.start 与 ipc.done
        expectOk(await client.callTool({ name: "read", arguments: { path: "demo.txt" } }));
        expect(transport.sessionId).toBe(sidBefore);

        const diskAfterDebug = readDiskLogText(server.configPath);
        expect(diskAfterDebug).toContain("[DEBUG] [tool.start]");
        expect(diskAfterDebug).toContain("[DEBUG] [ipc.done]");
        expect(diskAfterDebug).toContain("[INFO] [panel.settings]");

        // 6. 热切回 info 后，新增调用不再记 DEBUG
        expect(
          (
            await fetch(`${server.panelUrl}/api/settings`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ logLevel: "info" }),
            })
          ).status,
        ).toBe(200);
        const beforeSecondRead = readDiskLogText(server.configPath).length;
        expectOk(await client.callTool({ name: "read", arguments: { path: "demo.txt" } }));
        const delta = readDiskLogText(server.configPath).slice(beforeSecondRead);
        expect(delta).toContain("[INFO] [tool.ok]");
        expect(delta).not.toContain("[DEBUG]");
      } finally {
        await transport.terminateSession().catch(() => {});
        await client.close().catch(() => {});
        await server.stop();
      }
    },
    30_000,
  );

  it(
    "运行指纹、热切换结果回显（/api/hotswap & /api/status）与 /api/logs 过滤增强",
    async () => {
      const server = await startServer({ token: "obs-fp-secret-token" });
      try {
        // 1. /health 与 /api/status 返回一致的 version / buildId / startedAt / pid
        const healthRes = await fetch(`${server.mcpUrl.origin}/health`);
        expect(healthRes.status).toBe(200);
        const health = (await healthRes.json()) as {
          ok: boolean;
          version?: string;
          buildId?: string;
          startedAt?: string;
          pid?: number;
        };
        expect(health.ok).toBe(true);
        expect(health.version).toMatch(/^\d+\.\d+\.\d+/);
        expect(health.buildId).toMatch(/^[0-9a-f]{8}$/);
        expect(typeof health.startedAt).toBe("string");
        expect(typeof health.pid).toBe("number");

        const statusRes = await fetch(`${server.panelUrl}/api/status`);
        expect(statusRes.status).toBe(200);
        const status = (await statusRes.json()) as {
          version: string;
          buildId?: string;
          startedAt?: string;
          pid?: number;
          lastHotswap?: unknown;
        };
        expect(status.buildId).toBe(health.buildId);
        expect(status.startedAt).toBe(health.startedAt);
        expect(status.pid).toBe(health.pid);
        expect(status.lastHotswap).toBeNull();

        // 2. /api/hotswap 文件不存在返回 null；写入 last-hotswap.json 后立即回显并脱敏
        const hsEmpty = await fetch(`${server.panelUrl}/api/hotswap`);
        expect(hsEmpty.status).toBe(200);
        expect(((await hsEmpty.json()) as { lastHotswap: unknown }).lastHotswap).toBeNull();

        const logsDir = path.join(path.dirname(server.configPath), "logs");
        writeFileSync(
          path.join(logsDir, "last-hotswap.json"),
          JSON.stringify({
            status: "ok",
            mode: "in-place",
            at: "2026-11-27T08:00:00.000Z",
            detail: "pid=1234 token=obs-fp-secret-token",
          }),
          "utf8",
        );
        const hsRes = await fetch(`${server.panelUrl}/api/hotswap`);
        expect(hsRes.status).toBe(200);
        const hsBody = (await hsRes.json()) as {
          lastHotswap: { status: string; mode: string; at: string; detail: string } | null;
        };
        expect(hsBody.lastHotswap?.status).toBe("ok");
        expect(hsBody.lastHotswap?.mode).toBe("in-place");
        expect(hsBody.lastHotswap?.detail).not.toContain("obs-fp-secret-token");

        // 3. /api/logs 过滤：先制造一条 WARN（鉴权拒绝），再按 level=warn 与 q=auth.deny 过滤
        await fetch(server.mcpUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer wrong-tok" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
        });

        const warnLogsRes = await fetch(`${server.panelUrl}/api/logs?level=warn&q=auth.deny&limit=5`);
        expect(warnLogsRes.status).toBe(200);
        const warnLogs = (await warnLogsRes.json()) as { lines: string[] };
        expect(warnLogs.lines.length).toBeGreaterThanOrEqual(1);
        expect(warnLogs.lines.length).toBeLessThanOrEqual(5);
        for (const line of warnLogs.lines) {
          expect(line).toMatch(/\[(WARN|ERROR)\]/);
          expect(line.toLowerCase()).toContain("auth.deny");
          expect(line.toLowerCase()).not.toContain("authorization");
        }
      } finally {
        await server.stop();
      }
    },
    30_000,
  );
});
