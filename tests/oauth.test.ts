import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OAuthProvider } from "../src/oauth.js";

const APPROVAL = "nexus-test-token";
const REDIRECT = "https://gemini.example.com/oauth/callback";

let server: http.Server;
let base: string;
let provider: OAuthProvider;
let tmpDir: string;
let nowMs: number;

function pkce() {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

async function register(body: Record<string, unknown> = {}) {
  const res = await fetch(`${base}/oauth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ redirect_uris: [REDIRECT], client_name: "Gemini", ...body }),
  });
  return { status: res.status, json: (await res.json()) as Record<string, any> };
}

async function approve(clientId: string, challenge: string, token = APPROVAL, action = "approve") {
  const form = new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECT,
    response_type: "code",
    state: "xyz",
    code_challenge: challenge,
    code_challenge_method: "S256",
    approval_token: token,
    action,
  });
  return fetch(`${base}/oauth/authorize`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
    redirect: "manual",
  });
}

async function tokenRequest(params: Record<string, string>, basic?: string) {
  const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded" };
  if (basic) headers.Authorization = `Basic ${basic}`;
  const res = await fetch(`${base}/oauth/token`, {
    method: "POST",
    headers,
    body: new URLSearchParams(params).toString(),
  });
  return { status: res.status, json: (await res.json()) as Record<string, any> };
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-oauth-"));
  nowMs = Date.now();
  provider = new OAuthProvider({
    approvalSecret: APPROVAL,
    publicBaseUrl: () => base,
    storePath: path.join(tmpDir, "oauth-store.json"),
    now: () => nowMs,
  });
  server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", base);
    const handled = await provider.handle(req, res, url.pathname, url);
    if (!handled) {
      res.writeHead(404);
      res.end();
    }
  });
  let port = 0;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    const addr = server.address();
    port = typeof addr === "object" && addr && typeof addr.port === "number" ? addr.port : 0;
    if (port > 0) break;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  if (port <= 0) throw new Error("无法为 OAuth 测试分配有效的本机临时端口");
  base = `http://127.0.0.1:${port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections?.();
  });
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("OAuth provider", () => {
  it("提供 RFC 9728 资源元数据与 RFC 8414 授权服务器元数据", async () => {
    const pr = (await (await fetch(`${base}/.well-known/oauth-protected-resource`)).json()) as Record<string, any>;
    expect(pr.resource).toBe(`${base}/mcp`);
    expect(pr.authorization_servers).toEqual([base]);
    expect(pr.scopes_supported).toEqual(["mcp"]);

    // 带路径后缀的形式也服务（RFC 9728 资源路径推导）
    const prSuffix = (await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json()) as Record<string, any>;
    expect(prSuffix.resource).toBe(`${base}/mcp`);

    const as = (await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json()) as Record<string, any>;
    expect(as.issuer).toBe(base);
    expect(as.authorization_endpoint).toBe(`${base}/oauth/authorize`);
    expect(as.token_endpoint).toBe(`${base}/oauth/token`);
    expect(as.registration_endpoint).toBe(`${base}/oauth/register`);
    expect(as.code_challenge_methods_supported).toEqual(["S256"]);
    expect(as.grant_types_supported).toEqual(["authorization_code", "refresh_token"]);
  });

  it("动态注册 + PKCE 换令牌 + refresh 轮换（机密客户端）", async () => {
    const reg = await register();
    expect(reg.status).toBe(201);
    expect(reg.json.client_id).toBeTruthy();
    expect(reg.json.client_secret).toBeTruthy();
    expect(reg.json.redirect_uris).toEqual([REDIRECT]);

    const { verifier, challenge } = pkce();
    const authRes = await approve(reg.json.client_id as string, challenge);
    expect(authRes.status).toBe(302);
    const loc = new URL(authRes.headers.get("location") as string);
    expect(loc.origin + loc.pathname).toBe(REDIRECT);
    expect(loc.searchParams.get("state")).toBe("xyz");
    const code = loc.searchParams.get("code") as string;

    const basic = Buffer.from(`${reg.json.client_id}:${reg.json.client_secret}`).toString("base64");
    const tok = await tokenRequest(
      { grant_type: "authorization_code", code, redirect_uri: REDIRECT, code_verifier: verifier },
      basic,
    );
    expect(tok.status).toBe(200);
    expect(tok.json.token_type).toBe("Bearer");
    expect(tok.json.refresh_token).toBeTruthy();
    expect(provider.validateAccessToken(tok.json.access_token as string)).toBe(true);

    // 授权码一次性：重放被拒
    const replay = await tokenRequest(
      { grant_type: "authorization_code", code, redirect_uri: REDIRECT, code_verifier: verifier },
      basic,
    );
    expect(replay.json.error).toBe("invalid_grant");

    // refresh 轮换：旧 token 换新后立刻失效
    const refreshed = await tokenRequest(
      { grant_type: "refresh_token", refresh_token: tok.json.refresh_token as string },
      basic,
    );
    expect(refreshed.status).toBe(200);
    expect(refreshed.json.refresh_token).not.toBe(tok.json.refresh_token);
    const reuse = await tokenRequest(
      { grant_type: "refresh_token", refresh_token: tok.json.refresh_token as string },
      basic,
    );
    expect(reuse.json.error).toBe("invalid_grant");
  });

  it("接受 Gemini 应用连接器的真实注册负载（6 个重定向 URI + client_secret_post）", async () => {
    const id = "user_bound_custom-mcp-1234567890-nexus";
    const hosts = [
      "oauth-redirect-sandbox.googleusercontent.com",
      "oauth-redirect-test.googleusercontent.com",
      "oauth-redirect.googleusercontent.com",
    ];
    const redirectUris = hosts.flatMap((h) => [`https://${h}/r/${id}`, `https://${h}/a/${id}`]);
    const res = await fetch(`${base}/oauth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "Google",
        redirect_uris: redirectUris,
        response_types: ["code"],
        grant_types: ["authorization_code", "refresh_token"],
        token_endpoint_auth_method: "client_secret_post",
      }),
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as Record<string, any>;
    expect(json.redirect_uris).toHaveLength(6);
    expect(json.client_secret).toBeTruthy();

    const { verifier, challenge } = pkce();
    const form = new URLSearchParams({
      client_id: json.client_id as string,
      redirect_uri: redirectUris[2] as string,
      response_type: "code",
      state: "g",
      code_challenge: challenge,
      code_challenge_method: "S256",
      approval_token: APPROVAL,
      action: "approve",
    });
    const auth = await fetch(`${base}/oauth/authorize`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
      redirect: "manual",
    });
    const code = new URL(auth.headers.get("location") as string).searchParams.get("code") as string;
    const tok = await tokenRequest({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUris[2] as string,
      code_verifier: verifier,
      client_id: json.client_id as string,
      client_secret: json.client_secret as string,
    });
    expect(tok.status).toBe(200);
  });

  it("超过 10 个重定向 URI 注册被拒", async () => {
    const uris: string[] = [];
    for (let i = 0; i < 11; i += 1) uris.push(`https://cb${i}.example.com/callback`);
    const res = await register({ redirect_uris: uris });
    expect(res.status).toBe(400);
    expect(res.json.error).toBe("invalid_redirect_uri");
  });

  it("支持公开客户端（token_endpoint_auth_method=none）", async () => {
    const reg = await register({ token_endpoint_auth_method: "none" });
    expect(reg.json.client_secret).toBeUndefined();
    const { verifier, challenge } = pkce();
    const code = new URL(
      (await approve(reg.json.client_id as string, challenge)).headers.get("location") as string,
    ).searchParams.get("code") as string;
    const tok = await tokenRequest({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT,
      code_verifier: verifier,
      client_id: reg.json.client_id as string,
    });
    expect(tok.status).toBe(200);
  });

  it("授权请求缺 PKCE 或方法不对时拒绝", async () => {
    const reg = await register();

    const noChallenge = await fetch(
      `${base}/oauth/authorize?client_id=${reg.json.client_id}&redirect_uri=${encodeURIComponent(REDIRECT)}&response_type=code`,
    );
    expect(noChallenge.status).toBe(400);
    const body = (await noChallenge.text()) as string;
    expect(body).toContain("S256");

    const wrongMethod = await fetch(
      `${base}/oauth/authorize?client_id=${reg.json.client_id}&redirect_uri=${encodeURIComponent(REDIRECT)}&response_type=code&code_challenge=abc&code_challenge_method=plain`,
    );
    expect(wrongMethod.status).toBe(400);

    // RFC 7636：challenge 形状不对（长度或字符集）同样拒绝
    const malformed = await fetch(
      `${base}/oauth/authorize?client_id=${reg.json.client_id}&redirect_uri=${encodeURIComponent(REDIRECT)}&response_type=code&code_challenge=${"~".repeat(20)}&code_challenge_method=S256`,
    );
    expect(malformed.status).toBe(400);
  });

  it("授权页不输入正确的本地令牌不放行", async () => {
    const reg = await register();
    const { challenge } = pkce();
    const wrong = await approve(reg.json.client_id as string, challenge, "wrong-token");
    expect(wrong.status).toBe(401);
    expect(wrong.headers.get("location")).toBeNull();

    const empty = await approve(reg.json.client_id as string, challenge, "");
    expect(empty.status).toBe(401);
  });

  it("拒绝授权时回 access_denied", async () => {
    const reg = await register();
    const res = await approve(reg.json.client_id as string, pkce().challenge, APPROVAL, "deny");
    expect(res.status).toBe(302);
    expect(new URL(res.headers.get("location") as string).searchParams.get("error")).toBe("access_denied");
  });

  it("PKCE verifier 错误、未注册的 redirect_uri、非 https 重定向都被拒", async () => {
    const reg = await register();
    const { challenge } = pkce();
    const code = new URL(
      (await approve(reg.json.client_id as string, challenge)).headers.get("location") as string,
    ).searchParams.get("code") as string;
    const basic = Buffer.from(`${reg.json.client_id}:${reg.json.client_secret}`).toString("base64");

    const badVerifier = await tokenRequest(
      { grant_type: "authorization_code", code, redirect_uri: REDIRECT, code_verifier: "nope" },
      basic,
    );
    expect(badVerifier.json.error).toBe("invalid_grant");

    const wrongSecret = await tokenRequest(
      { grant_type: "refresh_token", refresh_token: "x" },
      Buffer.from(`${reg.json.client_id}:bad`).toString("base64"),
    );
    expect(wrongSecret.status).toBe(401);

    const unregistered = await fetch(
      `${base}/oauth/authorize?client_id=${reg.json.client_id}&redirect_uri=${encodeURIComponent("https://evil.example/cb")}&response_type=code&code_challenge=${challenge}&code_challenge_method=S256`,
    );
    expect(unregistered.status).toBe(400);

    const nonHttps = await register({ redirect_uris: ["http://evil.example/cb"] });
    expect(nonHttps.status).toBe(400);
  });

  it("授权端点不带参数时渲染说明页（面板入口直达）", async () => {
    const res = await fetch(`${base}/oauth/authorize`);
    expect(res.status).toBe(200);
    const body = (await res.text()) as string;
    expect(body).toContain("/oauth/authorize");
  });

  it("授权令牌连错触发限速（同 IP 每分钟 5 次失败后 429）", async () => {
    const reg = await register();
    const { challenge } = pkce();
    for (let i = 0; i < 5; i += 1) {
      const res = await approve(reg.json.client_id as string, challenge, "bad");
      expect(res.status).toBe(401);
    }
    const blocked = await approve(reg.json.client_id as string, challenge, APPROVAL);
    expect(blocked.status).toBe(429);

    // 窗口过了就恢复
    nowMs += 61_000;
    const recovered = await approve(reg.json.client_id as string, challenge, APPROVAL);
    expect(recovered.status).toBe(302);
  });

  it("令牌以哈希落盘，重启后仍然有效", async () => {
    const reg = await register({ token_endpoint_auth_method: "none" });
    const { verifier, challenge } = pkce();
    const code = new URL(
      (await approve(reg.json.client_id as string, challenge)).headers.get("location") as string,
    ).searchParams.get("code") as string;
    const tok = await tokenRequest({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT,
      code_verifier: verifier,
      client_id: reg.json.client_id as string,
    });

    const raw = fs.readFileSync(path.join(tmpDir, "oauth-store.json"), "utf-8");
    expect(raw).not.toContain(tok.json.access_token);
    expect(raw).not.toContain(tok.json.refresh_token);
    expect(raw).not.toContain(APPROVAL);

    const reloaded = new OAuthProvider({
      approvalSecret: APPROVAL,
      publicBaseUrl: () => base,
      storePath: path.join(tmpDir, "oauth-store.json"),
    });
    expect(reloaded.validateAccessToken(tok.json.access_token as string)).toBe(true);
    expect(reloaded.validateAccessToken("nexus_at_bogus")).toBe(false);
  });

  it("401 响应头指向 RFC 9728 元数据", () => {
    const header = provider.wwwAuthenticate();
    expect(header).toContain(`resource_metadata="${base}/.well-known/oauth-protected-resource"`);
    expect(header.startsWith("Bearer")).toBe(true);
  });
});
