/**
 * OAuth 2.1 授权服务器，供远程 MCP 客户端（Gemini 网页版自定义 MCP、ChatGPT 连接器等）接入。
 *
 * - RFC 9728 受保护资源元数据
 * - RFC 8414 授权服务器元数据
 * - RFC 7591 动态客户端注册（最多 10 个重定向 URI）
 * - RFC 7636 PKCE（只接受 S256）
 * - refresh token 轮换
 *
 * 批准授权必须在本页输入本地令牌（config.json 的 token），只拿到公网隧道地址拿不到令牌。
 * 落盘内容一律哈希：客户端密钥、访问令牌、刷新令牌都不以明文保存。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 小时
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 天
const AUTH_CODE_TTL_MS = 5 * 60 * 1000; // 5 分钟
const MAX_CLIENTS = 200;
const MAX_REDIRECT_URIS = 10;
const MAX_OAUTH_BODY_BYTES = 64 * 1024;
/** 同一 IP 每分钟授权令牌输错超过 5 次就锁到窗口结束，挡公网爆破 */
const APPROVAL_FAILURE_WINDOW_MS = 60_000;
const APPROVAL_FAILURE_LIMIT = 5;
/** RFC 7636 §4.2：code_challenge 是 43-128 个非保留字符 */
const CHALLENGE_PATTERN = /^[A-Za-z0-9\-._~]{43,128}$/;

interface OAuthClient {
  client_id: string;
  client_secret_hash?: string;
  token_endpoint_auth_method: "none" | "client_secret_basic" | "client_secret_post";
  redirect_uris: string[];
  client_name?: string;
  created_at: number;
}

interface StoredToken {
  client_id: string;
  exp: number;
}

interface OAuthStore {
  clients: Record<string, OAuthClient>;
  accessTokens: Record<string, StoredToken>;
  refreshTokens: Record<string, StoredToken>;
}

interface PendingCode {
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  exp: number;
}

export interface OAuthProviderOptions {
  /** 批准授权必须输入的本地令牌；传函数以便配置热重载后仍读到最新值 */
  approvalSecret: string | (() => string);
  /** 对外公布的 base URL（隧道地址优先），元数据里的 issuer 等都从这里拼 */
  publicBaseUrl: string | (() => string);
  /** OAuth 数据落盘路径（config.json 旁的 oauth-store.json） */
  storePath: string;
  now?: () => number;
}

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

/** 等长 + 常量时间比较；供鉴权路径复用 */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

/**
 * 限速用的客户端标识。请求只可能从两条路进来：
 * 隧道（cloudflared 在本机转发，socket 是 127.0.0.1）或本机直连。
 * 只有 loopback 直连时才信任 CF-Connecting-IP，外面直连伪造的头不采信。
 */
function clientIp(req: IncomingMessage): string {
  const remote = req.socket.remoteAddress ?? "unknown";
  const loopback = remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
  if (loopback) {
    const forwarded = req.headers["cf-connecting-ip"];
    const value = Array.isArray(forwarded) ? forwarded[0] : forwarded;
    if (value) return String(value).split(",")[0]?.trim() || remote;
  }
  return remote;
}

function randomToken(prefix: string): string {
  return `${prefix}${crypto.randomBytes(32).toString("base64url")}`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** https 随便用；http 只放行 loopback（RFC 8252，给本机 CLI 客户端用） */
function isAllowedRedirectUri(uri: string): boolean {
  try {
    const parsed = new URL(uri);
    if (parsed.hash) return false;
    if (parsed.protocol === "https:") return true;
    return (
      parsed.protocol === "http:" &&
      (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost" || parsed.hostname === "[::1]")
    );
  } catch {
    return false;
  }
}

function parseBody(raw: string, contentType = ""): Record<string, any> {
  if (!raw.trim()) return {};
  if (contentType.includes("application/json")) {
    try {
      const parsed: unknown = JSON.parse(raw);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, any>) : {};
    } catch {
      return {};
    }
  }
  return Object.fromEntries(new URLSearchParams(raw).entries());
}

function sendJson(res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    Pragma: "no-cache",
    ...extraHeaders,
  });
  res.end(JSON.stringify(body));
}

function sendOAuthError(res: ServerResponse, status: number, error: string, description: string): void {
  sendJson(res, status, { error, error_description: description });
}

function sendHtml(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Frame-Options": "DENY",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action *; frame-ancestors 'none'",
    "Referrer-Policy": "no-referrer",
  });
  res.end(html);
}

export class OAuthProvider {
  private store: OAuthStore;
  private codes = new Map<string, PendingCode>();
  private approvalFailures = new Map<string, { count: number; windowStart: number }>();
  private readonly opts: OAuthProviderOptions;
  private readonly now: () => number;

  constructor(opts: OAuthProviderOptions) {
    this.opts = opts;
    this.now = opts.now ?? Date.now;
    this.store = this.load();
  }

  private approvalSecret(): string {
    return typeof this.opts.approvalSecret === "function" ? this.opts.approvalSecret() : this.opts.approvalSecret;
  }

  private base(): string {
    const raw = typeof this.opts.publicBaseUrl === "function" ? this.opts.publicBaseUrl() : this.opts.publicBaseUrl;
    return raw.replace(/\/+$/, "");
  }

  oauthEnabled(): boolean {
    return this.approvalSecret() !== "";
  }

  authorizeUrl(): string {
    return `${this.base()}/oauth/authorize`;
  }

  // ---------------------------------------------------------------- 存取

  private load(): OAuthStore {
    try {
      if (fs.existsSync(this.opts.storePath)) {
        const parsed = JSON.parse(fs.readFileSync(this.opts.storePath, "utf-8")) as Partial<OAuthStore>;
        return {
          clients: parsed.clients ?? {},
          accessTokens: parsed.accessTokens ?? {},
          refreshTokens: parsed.refreshTokens ?? {},
        };
      }
    } catch (err) {
      console.error(`[nexus-mcp] OAuth 数据读取失败，从空库开始: ${(err as Error).message}`);
    }
    return { clients: {}, accessTokens: {}, refreshTokens: {} };
  }

  private persist(): void {
    this.prune();
    try {
      fs.mkdirSync(path.dirname(this.opts.storePath), { recursive: true });
      const tmp = `${this.opts.storePath}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.store), { encoding: "utf-8", mode: 0o600 });
      fs.renameSync(tmp, this.opts.storePath);
    } catch (err) {
      console.error(`[nexus-mcp] OAuth 数据写入失败: ${(err as Error).message}`);
    }
  }

  private prune(): void {
    const now = this.now();
    for (const map of [this.store.accessTokens, this.store.refreshTokens]) {
      for (const [key, value] of Object.entries(map)) {
        if (value.exp <= now) delete map[key];
      }
    }
    for (const [key, value] of this.codes) {
      if (value.exp <= now) this.codes.delete(key);
    }
  }

  // ---------------------------------------------------------------- 对外 API

  validateAccessToken(token: string): boolean {
    const entry = this.store.accessTokens[sha256(token)];
    return Boolean(entry && entry.exp > this.now() && this.store.clients[entry.client_id]);
  }

  /** /mcp 401 响应的 WWW-Authenticate 值，指向 RFC 9728 元数据 */
  wwwAuthenticate(error?: string): string {
    const parts = [
      'Bearer realm="nexus-mcp"',
      `resource_metadata="${this.base()}/.well-known/oauth-protected-resource"`,
      'scope="mcp"',
    ];
    if (error) parts.push(`error="${error}"`);
    return parts.join(", ");
  }

  /** 处理 OAuth 相关请求；返回 false 表示不是 OAuth 路径，交给调用方 */
  async handle(req: IncomingMessage, res: ServerResponse, pathname: string, url: URL): Promise<boolean> {
    const method = req.method ?? "GET";

    if (method === "GET" && (pathname === "/.well-known/oauth-protected-resource" || pathname.startsWith("/.well-known/oauth-protected-resource/"))) {
      sendJson(res, 200, {
        resource: `${this.base()}/mcp`,
        authorization_servers: [this.base()],
        bearer_methods_supported: ["header"],
        scopes_supported: ["mcp"],
        resource_name: "nexus-mcp",
      });
      return true;
    }

    if (method === "GET" && pathname === "/.well-known/oauth-authorization-server") {
      sendJson(res, 200, {
        issuer: this.base(),
        authorization_endpoint: `${this.base()}/oauth/authorize`,
        token_endpoint: `${this.base()}/oauth/token`,
        registration_endpoint: `${this.base()}/oauth/register`,
        response_types_supported: ["code"],
        response_modes_supported: ["query"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post", "none"],
        scopes_supported: ["mcp"],
      });
      return true;
    }

    if (pathname === "/oauth/register" && method === "POST") {
      await this.handleRegister(req, res);
      return true;
    }
    if (pathname === "/oauth/authorize" && method === "GET") {
      this.handleAuthorizeGet(res, url);
      return true;
    }
    if (pathname === "/oauth/authorize" && method === "POST") {
      await this.handleAuthorizePost(req, res);
      return true;
    }
    if (pathname === "/oauth/token" && method === "POST") {
      await this.handleToken(req, res);
      return true;
    }
    if (pathname.startsWith("/oauth/") || pathname.startsWith("/.well-known/oauth")) {
      sendOAuthError(res, 405, "invalid_request", "不支持的 OAuth 端点或方法");
      return true;
    }
    return false;
  }

  // ---------------------------------------------------------------- 动态注册

  private async handleRegister(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let raw: string;
    try {
      raw = await readBody(req, MAX_OAUTH_BODY_BYTES);
    } catch {
      sendOAuthError(res, 413, "invalid_client_metadata", "请求体过大");
      return;
    }
    const body = parseBody(raw, String(req.headers["content-type"] ?? "application/json"));

    const redirectUris = body.redirect_uris;
    if (!Array.isArray(redirectUris) || redirectUris.length === 0 || redirectUris.length > MAX_REDIRECT_URIS) {
      sendOAuthError(res, 400, "invalid_redirect_uri", `redirect_uris 必须是 1 到 ${MAX_REDIRECT_URIS} 个的数组`);
      return;
    }
    for (const uri of redirectUris) {
      if (typeof uri !== "string" || !isAllowedRedirectUri(uri)) {
        sendOAuthError(res, 400, "invalid_redirect_uri", `不支持的重定向地址: ${String(uri).slice(0, 200)}`);
        return;
      }
    }

    const authMethod = body.token_endpoint_auth_method ?? "client_secret_basic";
    if (authMethod !== "none" && authMethod !== "client_secret_basic" && authMethod !== "client_secret_post") {
      sendOAuthError(res, 400, "invalid_client_metadata", "不支持的 token_endpoint_auth_method");
      return;
    }
    const grantTypes: string[] = Array.isArray(body.grant_types) ? body.grant_types : ["authorization_code", "refresh_token"];
    if (!grantTypes.includes("authorization_code")) {
      sendOAuthError(res, 400, "invalid_client_metadata", "grant_types 必须包含 authorization_code");
      return;
    }

    // 超容量时挤掉最早的动态客户端，防止注册接口把磁盘撑爆
    const dynamicClients = Object.values(this.store.clients);
    if (dynamicClients.length >= MAX_CLIENTS) {
      dynamicClients.sort((a, b) => a.created_at - b.created_at);
      for (const client of dynamicClients.slice(0, dynamicClients.length - MAX_CLIENTS + 1)) {
        delete this.store.clients[client.client_id];
      }
    }

    const clientId = `nexus_client_${crypto.randomBytes(16).toString("hex")}`;
    const clientSecret = authMethod === "none" ? undefined : randomToken("nexus_secret_");
    const clientName = typeof body.client_name === "string" && body.client_name.trim() ? body.client_name.slice(0, 120) : undefined;

    this.store.clients[clientId] = {
      client_id: clientId,
      client_secret_hash: clientSecret ? sha256(clientSecret) : undefined,
      token_endpoint_auth_method: authMethod,
      redirect_uris: redirectUris.filter((uri): uri is string => typeof uri === "string"),
      client_name: clientName,
      created_at: this.now(),
    };
    this.persist();

    sendJson(res, 201, {
      client_id: clientId,
      ...(clientSecret ? { client_secret: clientSecret, client_secret_expires_at: 0 } : {}),
      client_id_issued_at: Math.floor(this.now() / 1000),
      client_name: clientName,
      redirect_uris: redirectUris,
      token_endpoint_auth_method: authMethod,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      scope: "mcp",
    });
  }

  // ---------------------------------------------------------------- 授权

  private validateAuthorizeParams(params: Record<string, any>): { ok: true; client: OAuthClient } | { ok: false; message: string } {
    const client = this.store.clients[String(params.client_id ?? "")];
    if (!client) return { ok: false, message: "client_id 不认识。请在客户端里删掉这个连接器重新添加。" };
    const redirectUri = String(params.redirect_uri ?? "");
    if (!client.redirect_uris.includes(redirectUri)) {
      return { ok: false, message: "redirect_uri 不在该客户端的注册列表里。" };
    }
    if (params.response_type !== "code") return { ok: false, message: "response_type 必须是 code。" };
    const challenge = String(params.code_challenge ?? "");
    if (!CHALLENGE_PATTERN.test(challenge) || params.code_challenge_method !== "S256") {
      return { ok: false, message: "必须使用 PKCE 且 code_challenge_method=S256。" };
    }
    return { ok: true, client };
  }

  private handleAuthorizeGet(res: ServerResponse, url: URL): void {
    const params = Object.fromEntries(url.searchParams.entries());

    // 没带任何 OAuth 参数（比如从面板入口直接点进来）：给说明页，别甩一脸报错
    if (!params.client_id && !params.redirect_uri) {
      sendHtml(
        res,
        200,
        this.renderPage(
          "OAuth 授权端点",
          `<p>这是 nexus-mcp 的 OAuth 2.1 授权端点，由 MCP 客户端（如 Gemini 网页版的自定义 MCP 服务器）发起跳转后进入。</p>
<p class="muted">把面板上的 MCP 地址填进客户端后，客户端会带着参数跳转到 <code>${escapeHtml(`${this.base()}/oauth/authorize`)}</code>；批准时需要输入 config.json 里的 <code>token</code>。</p>
<p class="muted">资源元数据：<code>${escapeHtml(`${this.base()}/.well-known/oauth-protected-resource`)}</code></p>`,
        ),
      );
      return;
    }

    const check = this.validateAuthorizeParams(params);
    if (!check.ok) {
      sendHtml(res, 400, this.renderPage("授权请求无效", `<p class="err">${escapeHtml(check.message)}</p>`));
      return;
    }
    sendHtml(res, 200, this.renderConsent(params, check.client));
  }

  private async handleAuthorizePost(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let raw: string;
    try {
      raw = await readBody(req, MAX_OAUTH_BODY_BYTES);
    } catch {
      sendHtml(res, 413, this.renderPage("请求过大", ""));
      return;
    }
    const params = parseBody(raw, String(req.headers["content-type"] ?? ""));
    const check = this.validateAuthorizeParams(params);
    if (!check.ok) {
      sendHtml(res, 400, this.renderPage("授权请求无效", `<p class="err">${escapeHtml(check.message)}</p>`));
      return;
    }

    const redirect = new URL(String(params.redirect_uri));
    if (params.state) redirect.searchParams.set("state", String(params.state));
    redirect.searchParams.set("iss", this.base());

    if (params.action !== "approve") {
      redirect.searchParams.set("error", "access_denied");
      res.writeHead(302, { Location: redirect.toString(), "Cache-Control": "no-store" });
      res.end();
      return;
    }

    if (!this.approvalAllowed(req)) {
      sendHtml(res, 429, this.renderConsent(params, check.client, "尝试次数过多，请一分钟后再试。"));
      return;
    }

    const typed = String(params.approval_token ?? "").trim();
    if (!typed || !safeEqual(typed, this.approvalSecret())) {
      this.recordApprovalFailure(req);
      sendHtml(res, 401, this.renderConsent(params, check.client, "本地令牌不正确。"));
      return;
    }

    const code = randomToken("nexus_code_");
    this.codes.set(sha256(code), {
      client_id: check.client.client_id,
      redirect_uri: String(params.redirect_uri),
      code_challenge: String(params.code_challenge),
      exp: this.now() + AUTH_CODE_TTL_MS,
    });
    redirect.searchParams.set("code", code);
    res.writeHead(302, { Location: redirect.toString(), "Cache-Control": "no-store" });
    res.end();
  }

  private approvalAllowed(req: IncomingMessage): boolean {
    const record = this.approvalFailures.get(clientIp(req));
    if (!record) return true;
    if (this.now() - record.windowStart >= APPROVAL_FAILURE_WINDOW_MS) return true;
    return record.count < APPROVAL_FAILURE_LIMIT;
  }

  private recordApprovalFailure(req: IncomingMessage): void {
    const key = clientIp(req);
    const now = this.now();
    const record = this.approvalFailures.get(key);
    if (!record || now - record.windowStart >= APPROVAL_FAILURE_WINDOW_MS) {
      this.approvalFailures.set(key, { count: 1, windowStart: now });
      return;
    }
    record.count += 1;
  }

  // ---------------------------------------------------------------- 令牌

  private authenticateClient(req: IncomingMessage, body: Record<string, any>): OAuthClient | null {
    let clientId = typeof body.client_id === "string" ? body.client_id : "";
    let clientSecret = typeof body.client_secret === "string" ? body.client_secret : "";

    const authHeader = String(req.headers.authorization ?? "");
    if (authHeader.toLowerCase().startsWith("basic ")) {
      try {
        const decoded = Buffer.from(authHeader.slice(6).trim(), "base64").toString("utf-8");
        const sep = decoded.indexOf(":");
        if (sep >= 0) {
          clientId = decodeURIComponent(decoded.slice(0, sep));
          clientSecret = decodeURIComponent(decoded.slice(sep + 1));
        }
      } catch {
        return null;
      }
    }

    const client = this.store.clients[clientId];
    if (!client) return null;
    if (client.client_secret_hash) {
      if (!clientSecret || !safeEqual(sha256(clientSecret), client.client_secret_hash)) return null;
    }
    return client;
  }

  private issueTokens(clientId: string): Record<string, unknown> {
    const accessToken = randomToken("nexus_at_");
    const refreshToken = randomToken("nexus_rt_");
    const now = this.now();
    this.store.accessTokens[sha256(accessToken)] = { client_id: clientId, exp: now + ACCESS_TOKEN_TTL_MS };
    this.store.refreshTokens[sha256(refreshToken)] = { client_id: clientId, exp: now + REFRESH_TOKEN_TTL_MS };
    this.persist();
    return {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
      refresh_token: refreshToken,
      scope: "mcp",
    };
  }

  private async handleToken(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let raw: string;
    try {
      raw = await readBody(req, MAX_OAUTH_BODY_BYTES);
    } catch {
      sendOAuthError(res, 413, "invalid_request", "请求体过大");
      return;
    }
    const body = parseBody(raw, String(req.headers["content-type"] ?? ""));

    const client = this.authenticateClient(req, body);
    if (!client) {
      sendJson(
        res,
        401,
        { error: "invalid_client", error_description: "客户端认证失败" },
        { "WWW-Authenticate": 'Basic realm="nexus-mcp OAuth"' },
      );
      return;
    }

    if (body.grant_type === "authorization_code") {
      const codeKey = sha256(String(body.code ?? ""));
      const pending = this.codes.get(codeKey);
      this.codes.delete(codeKey); // 无论成败都一次性，防重放
      if (!pending || pending.exp <= this.now() || pending.client_id !== client.client_id) {
        sendOAuthError(res, 400, "invalid_grant", "授权码无效或已过期");
        return;
      }
      if (String(body.redirect_uri ?? "") !== pending.redirect_uri) {
        sendOAuthError(res, 400, "invalid_grant", "redirect_uri 与授权请求不一致");
        return;
      }
      const verifier = String(body.code_verifier ?? "");
      const computed = crypto.createHash("sha256").update(verifier).digest("base64url");
      if (!verifier || !safeEqual(computed, pending.code_challenge)) {
        sendOAuthError(res, 400, "invalid_grant", "PKCE 校验失败");
        return;
      }
      sendJson(res, 200, this.issueTokens(client.client_id));
      return;
    }

    if (body.grant_type === "refresh_token") {
      const key = sha256(String(body.refresh_token ?? ""));
      const entry = this.store.refreshTokens[key];
      if (!entry || entry.exp <= this.now() || entry.client_id !== client.client_id) {
        sendOAuthError(res, 400, "invalid_grant", "刷新令牌无效或已过期");
        return;
      }
      delete this.store.refreshTokens[key]; // 轮换：旧的立刻作废
      sendJson(res, 200, this.issueTokens(client.client_id));
      return;
    }

    sendOAuthError(res, 400, "unsupported_grant_type", "只支持 authorization_code 与 refresh_token");
  }

  // ---------------------------------------------------------------- 页面

  private renderConsent(params: Record<string, any>, client: OAuthClient, error?: string): string {
    const keys = ["client_id", "redirect_uri", "response_type", "state", "code_challenge", "code_challenge_method", "scope", "resource"];
    const hidden = keys
      .filter((key) => params[key] !== undefined)
      .map((key) => `<input type="hidden" name="${key}" value="${escapeHtml(String(params[key]))}">`)
      .join("\n");
    let redirectHost = "";
    try {
      redirectHost = new URL(String(params.redirect_uri)).host;
    } catch {
      // validateAuthorizeParams 已经确认 redirect_uri 合法，这里只是展示
    }
    const name = client.client_name || client.client_id;
    return this.renderPage(
      "授权访问本地 nexus-mcp",
      `<p><b>${escapeHtml(name)}</b> 请求通过 MCP 访问你电脑上的 nexus-mcp。</p>
<p class="muted">授权完成后将跳转到：<code>${escapeHtml(redirectHost)}</code></p>
<p class="muted">批准后，该客户端可通过 MCP 调用全部 9 个工具（受沙箱根目录与命令闸门约束）。</p>
${error ? `<p class="err">${escapeHtml(error)}</p>` : ""}
<form method="POST" action="/oauth/authorize" autocomplete="off">
${hidden}
<label for="t">本地令牌</label>
<p class="muted">输入 config.json 里 <code>token</code> 字段的值，批准才生效。</p>
<input id="t" type="password" name="approval_token" placeholder="config.json 的 token" autofocus>
<div class="row">
<button type="submit" name="action" value="deny" class="secondary">拒绝</button>
<button type="submit" name="action" value="approve">批准</button>
</div>
</form>`,
    );
  }

  private renderPage(title: string, body: string): string {
    return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;background:#f5f5f7;color:#1d1d1f;margin:0;padding:16px}
@media (prefers-color-scheme:dark){body{background:#111;color:#eee}.card{background:#1c1c1e!important}input{background:#2c2c2e;color:#eee;border-color:#444!important}}
.card{max-width:460px;margin:8vh auto;background:#fff;border-radius:12px;padding:24px;box-shadow:0 2px 12px rgba(0,0,0,.08)}
h1{font-size:20px;margin:0 0 16px}.muted{color:#888;font-size:13px}.err{color:#d93025}
label{display:block;font-size:13px;margin:16px 0 6px}input{width:100%;box-sizing:border-box;padding:10px;border:1px solid #ccc;border-radius:8px;font-size:14px}
.row{display:flex;gap:8px;justify-content:flex-end;margin-top:16px}
button{padding:9px 18px;border-radius:8px;border:0;background:#1a73e8;color:#fff;font-size:14px;cursor:pointer}
button.secondary{background:transparent;color:inherit;border:1px solid #999}
code{font-size:12px;word-break:break-all}
</style></head><body><div class="card"><h1>${escapeHtml(title)}</h1>${body}</div></body></html>`;
  }
}

async function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
      if (body.length > maxBytes) {
        req.destroy();
        reject(new Error("请求体过大"));
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}
