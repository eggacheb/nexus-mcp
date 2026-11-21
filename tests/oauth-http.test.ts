import crypto from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startServer } from "./support/server.js";
import type { RunningServer } from "./support/server.js";

const STATIC_TOKEN = "static-bearer-token-3f9d";
const TUNNEL_BASE = "https://nexus.example.test";

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

let server: RunningServer;
let configDir: string;

function pkce() {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

/** 从 /mcp 的 401 WWW-Authenticate 里取元数据地址，模拟客户端发现流程 */
async function discoverMetadataFromUnauthorized(): Promise<{ wwwAuth: string; metadataUrl: string; resource: string }> {
  const res = await fetch(server.mcpUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", method: "initialize", id: 1, params: {} }),
  });
  expect(res.status).toBe(401);
  const wwwAuth = res.headers.get("www-authenticate") ?? "";
  const match = /resource_metadata="([^"]+)"/.exec(wwwAuth);
  expect(match).toBeTruthy();
  const metadataUrl = match?.[1] as string;
  // 元数据地址是公网隧道地址（客户端经隧道才能拿到）；测试在本机端口取同样的内容
  const localPath = new URL(metadataUrl).pathname;
  const meta = await (await fetch(`${serverUrl()}${localPath}`)).json() as Record<string, any>;
  return { wwwAuth, metadataUrl, resource: meta.resource as string };
}

async function registerClient(): Promise<Record<string, any>> {
  const res = await fetch(`${serverUrl()}/oauth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      redirect_uris: ["https://oauth-redirect.googleusercontent.com/r/nexus-test"],
      client_name: "Gemini test",
      token_endpoint_auth_method: "none",
    }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as Record<string, any>;
}

function serverUrl(): string {
  return `http://127.0.0.1:${server.port}`;
}

async function authorizeForCode(clientId: string, challenge: string, approvalToken: string): Promise<Response> {
  const form = new URLSearchParams({
    client_id: clientId,
    redirect_uri: "https://oauth-redirect.googleusercontent.com/r/nexus-test",
    response_type: "code",
    state: "s1",
    code_challenge: challenge,
    code_challenge_method: "S256",
    approval_token: approvalToken,
    action: "approve",
  });
  return fetch(`${serverUrl()}/oauth/authorize`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
    redirect: "manual",
  });
}

async function redeemCode(code: string, verifier: string, clientId: string): Promise<{ status: number; json: Record<string, any> }> {
  const res = await fetch(`${serverUrl()}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: "https://oauth-redirect.googleusercontent.com/r/nexus-test",
      code_verifier: verifier,
      client_id: clientId,
    }).toString(),
  });
  return { status: res.status, json: (await res.json()) as Record<string, any> };
}

beforeAll(async () => {
  server = await startServer({ token: STATIC_TOKEN, tunnelUrl: TUNNEL_BASE });
  configDir = path.dirname(server.configPath);
}, 30_000);

afterAll(async () => {
  await server?.stop();
});

describe("HTTP 传输（OAuth + 静态 Bearer 并存）", () => {
  it(
    "无令牌请求 /mcp 返回 401，WWW-Authenticate 指向元数据，元数据 resource 是公网地址",
    async () => {
      const { metadataUrl, resource } = await discoverMetadataFromUnauthorized();
      expect(metadataUrl).toBe(`${TUNNEL_BASE}/.well-known/oauth-protected-resource`);
      expect(resource).toBe(`${TUNNEL_BASE}/mcp`);

      const asMeta = (await (await fetch(`${serverUrl()}/.well-known/oauth-authorization-server`)).json()) as Record<string, any>;
      expect(asMeta.issuer).toBe(TUNNEL_BASE);
    },
    20_000,
  );

  it(
    "OAuth 全流程走通：注册 → 授权（本地令牌批准）→ 换令牌 → OAuth 令牌连 MCP 列出 9 个工具",
    async () => {
      const reg = await registerClient();
      const { verifier, challenge } = pkce();
      const auth = await authorizeForCode(reg.client_id as string, challenge, STATIC_TOKEN);
      expect(auth.status).toBe(302);
      const code = new URL(auth.headers.get("location") as string).searchParams.get("code") as string;

      const tok = await redeemCode(code, verifier, reg.client_id as string);
      expect(tok.status).toBe(200);
      const accessToken = tok.json.access_token as string;

      const transport = new StreamableHTTPClientTransport(server.mcpUrl, {
        requestInit: { headers: { Authorization: `Bearer ${accessToken}` } },
      });
      const client = new Client({ name: "vitest-oauth", version: "0.1.0" });
      await client.connect(transport);
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name).sort()).toEqual(ALL_TOOLS);
      await transport.terminateSession();
      await client.close();
    },
    30_000,
  );

  it(
    "无效的 OAuth 令牌被拒，错误令牌不进服务日志",
    async () => {
      const error = await connectReject(`Bearer nexus_at_${"x".repeat(40)}`);
      expect(error.code).toBe(401);

      const logs = server.stderrText();
      expect(logs).not.toContain("nexus_at_");
    },
    20_000,
  );

  it(
    "refresh 轮换：旧 refresh token 换新后失效，新 access token 可用",
    async () => {
      const reg = await registerClient();
      const { verifier, challenge } = pkce();
      const auth = await authorizeForCode(reg.client_id as string, challenge, STATIC_TOKEN);
      const code = new URL(auth.headers.get("location") as string).searchParams.get("code") as string;
      const first = await redeemCode(code, verifier, reg.client_id as string);
      expect(first.status).toBe(200);

      const refreshRes = await fetch(`${serverUrl()}/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: first.json.refresh_token as string,
          client_id: reg.client_id as string,
        }).toString(),
      });
      expect(refreshRes.status).toBe(200);
      const refreshed = (await refreshRes.json()) as Record<string, any>;
      expect(refreshed.refresh_token).not.toBe(first.json.refresh_token);

      const reuse = await fetch(`${serverUrl()}/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: first.json.refresh_token as string,
          client_id: reg.client_id as string,
        }).toString(),
      });
      expect((await reuse.json() as Record<string, any>).error).toBe("invalid_grant");

      const transport = new StreamableHTTPClientTransport(server.mcpUrl, {
        requestInit: { headers: { Authorization: `Bearer ${refreshed.access_token as string}` } },
      });
      const client = new Client({ name: "vitest-oauth-refresh", version: "0.1.0" });
      await client.connect(transport);
      await client.listTools();
      await transport.terminateSession();
      await client.close();
    },
    30_000,
  );

  it(
    "静态 Bearer 令牌路径不受影响",
    async () => {
      const transport = new StreamableHTTPClientTransport(server.mcpUrl, {
        requestInit: { headers: { Authorization: `Bearer ${STATIC_TOKEN}` } },
      });
      const client = new Client({ name: "vitest-static", version: "0.1.0" });
      await client.connect(transport);
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name).sort()).toEqual(ALL_TOOLS);
      await transport.terminateSession();
      await client.close();
    },
    20_000,
  );

  it(
    "OAuth 令牌哈希落盘在 config 目录，文件里没有明文",
    async () => {
      const storePath = path.join(configDir, "oauth-store.json");
      expect(existsSync(storePath)).toBe(true);
      const raw = readFileSync(storePath, "utf-8");
      expect(raw).not.toContain(STATIC_TOKEN);
    },
    20_000,
  );

  it(
    "面板状态里 OAuth 入口已点亮并指向公网授权地址",
    async () => {
      const status = (await (await fetch(`${server.panelUrl}/api/status`)).json()) as Record<string, any>;
      expect(status.oauth.available).toBe(true);
      expect(status.oauth.url).toBe(`${TUNNEL_BASE}/oauth/authorize`);
    },
    20_000,
  );
});

async function connectReject(authHeader: string): Promise<Error & { code?: number }> {
  const transport = new StreamableHTTPClientTransport(server.mcpUrl, {
    requestInit: { headers: { Authorization: authHeader } },
  });
  const client = new Client({ name: "vitest-oauth-bad", version: "0.1.0" });
  return client.connect(transport).then(
    () => {
      throw new Error("预期连接失败，实际连上了");
    },
    (err: unknown) => err as Error & { code?: number },
  );
}
