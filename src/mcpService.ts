import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import path from "node:path";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppConfig } from "./config.js";
import { configFilePath } from "./config.js";
import { closeExecutor } from "./executor.js";
import { readBody, sendJson } from "./httpHelpers.js";
import { handleIconRequest } from "./icon.js";
import { getRuntimeIdentity } from "./status.js";
import { logDebug, logError, logInfo, logWarn, redactText } from "./log.js";
import { OAuthProvider, safeEqual } from "./oauth.js";
import { createServer } from "./server.js";

const MCP_PATH = "/mcp";
/** 健康检查：无鉴权，面板可达性探测与排障（公网/本地）都打这里 */
const HEALTH_PATH = "/health";
/** 请求体上限，与传输层默认值一致；超出直接 413，不进入解析 */
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const LISTEN_HOST = "127.0.0.1";
const SESSION_HEADER = "mcp-session-id";
/** 空闲超过这个时长且没有任何请求的会话直接回收，防止客户端异常断开造成泄漏 */
const IDLE_SESSION_MS = 30 * 60 * 1000;
const SESSION_SWEEP_MS = 60_000;

/** JSON-RPC 自定义错误码，落在服务端保留区间 -32000~-32099 */
const RPC_AUTH_FAILED = -32001;
const RPC_SESSION_GONE = -32002;
const RPC_PARSE_ERROR = -32700;
const RPC_INVALID_REQUEST = -32600;
const RPC_INTERNAL_ERROR = -32603;

interface Session {
  id?: string;
  server: McpServer;
  transport: StreamableHTTPServerTransport;
  closed: boolean;
  lastSeen: number;
}

export interface McpService {
  start(): Promise<void>;
  stop(options?: { preserveSessions?: boolean }): Promise<void>;
  isRunning(): boolean;
  port(): number;
  url(): string;
  sessionCount(): number;
  /** OAuth 授权入口状态，面板直接展示 */
  oauthInfo(): { available: boolean; url: string };
}

function isLoopback(address: string | undefined): boolean {
  if (!address) return false;
  if (address === "::1") return true;
  return address === "127.0.0.1" || address.startsWith("127.") || address.startsWith("::ffff:127.");
}

/**
 * 校验 Host 请求头是否指向本机回环地址，防止 token 为空时被 DNS Rebinding
 * 或不带转发头的原始 TCP 隧道（如 ssh -R / frp tcp）绕过本机直连限制。
 */
function isLoopbackHostHeader(hostHeader: string | undefined): boolean {
  if (!hostHeader) return false;
  const trimmed = hostHeader.trim();
  if (!trimmed || /[\s/\\@]/.test(trimmed)) return false;

  let hostname: string;
  if (trimmed.startsWith("[")) {
    const closeBracket = trimmed.indexOf("]");
    if (closeBracket < 0) return false;
    const rest = trimmed.slice(closeBracket + 1);
    if (rest !== "" && !/^:\d+$/.test(rest)) return false;
    hostname = trimmed.slice(1, closeBracket).toLowerCase();
    return hostname === "::1";
  }

  const colonIdx = trimmed.indexOf(":");
  if (colonIdx >= 0) {
    const portPart = trimmed.slice(colonIdx + 1);
    if (!/^\d+$/.test(portPart)) return false;
    hostname = trimmed.slice(0, colonIdx).toLowerCase();
  } else {
    hostname = trimmed.toLowerCase();
  }

  if (hostname === "localhost") return true;
  if (/^127(?:\.\d{1,3}){3}$/.test(hostname)) {
    return hostname.split(".").every((octet) => Number(octet) <= 255);
  }
  return false;
}

/**
 * 识别经 cloudflared 隧道或反向代理转发进本机回环端口的请求。
 * token 为空时仅允许本机进程直连，一旦带了代理转发头就说明流量可能来自外部入口，必须拒绝。
 */
function hasProxyForwardingHeaders(req: IncomingMessage): boolean {
  for (const name of ["cf-connecting-ip", "cf-ray", "x-forwarded-for", "x-real-ip", "forwarded"]) {
    const raw = req.headers[name];
    const text = Array.isArray(raw) ? raw.join(",") : raw;
    if (typeof text === "string" && text.trim() !== "") {
      return true;
    }
  }
  return false;
}

interface AuthFailure {
  status: number;
  reason: string;
  message: string;
  /** 令牌无效时带给 WWW-Authenticate 的 OAuth 错误码（RFC 6750） */
  oauthError?: string;
}

/** 日志只记录状态码与原因码；令牌、Authorization 头一律不进日志 */
function checkAuth(req: IncomingMessage, config: AppConfig, oauth: OAuthProvider): AuthFailure | null {
  const remote = req.socket.remoteAddress;

  if (!config.token) {
    if (!isLoopback(remote)) {
      return {
        status: 403,
        reason: "non_loopback",
        message: `配置里没有令牌，只接受本机连接；拒绝来自 ${remote ?? "未知地址"} 的请求。`,
      };
    }
    if (hasProxyForwardingHeaders(req)) {
      return {
        status: 403,
        reason: "proxy_header",
        message: "配置里没有令牌，只接受本机直连；拒绝经隧道或反向代理转发的请求。",
      };
    }
    if (!isLoopbackHostHeader(req.headers.host)) {
      return {
        status: 403,
        reason: "invalid_host",
        message: "配置里没有令牌，只接受本机直连；拒绝非本机 Host 头的请求。",
      };
    }
    return null;
  }

  const header = req.headers.authorization;
  if (!header) {
    return { status: 401, reason: "missing_credentials", message: "缺少 Authorization 请求头，需要 Bearer 令牌。" };
  }
  const [scheme, value] = header.split(" ");
  if (!scheme || scheme.toLowerCase() !== "bearer" || !value) {
    return { status: 401, reason: "invalid_scheme", message: "Authorization 头格式不对，需要写成 Bearer <令牌>。" };
  }
  if (safeEqual(value, config.token)) {
    return null;
  }
  // 静态令牌不匹配时再试 OAuth 访问令牌，两条鉴权路并存
  if (oauth.validateAccessToken(value)) {
    return null;
  }
  return {
    status: 401,
    reason: "invalid_token",
    message: "令牌不正确：既不是静态 Bearer 令牌，也不是有效的 OAuth 访问令牌。",
    oauthError: "invalid_token",
  };
}

function sendRpcError(
  res: ServerResponse,
  status: number,
  code: number,
  message: string,
  headers: Record<string, string> = {},
): void {
  sendJson(res, status, { jsonrpc: "2.0", error: { code, message }, id: null }, headers);
}

function sendSessionNotFound(res: ServerResponse, sessionId: string, method: string): void {
  logWarn("session.not_found", { sid: sessionId.slice(0, 8), method });
  sendRpcError(res, 404, RPC_SESSION_GONE, "会话不存在或已结束，请重新 initialize。");
}

function rpcControlMethods(parsed: unknown): string[] {
  const messages = Array.isArray(parsed) ? parsed : [parsed];
  const methods: string[] = [];
  for (const message of messages) {
    if (typeof message === "object" && message !== null) {
      const m = (message as { method?: unknown }).method;
      if (typeof m === "string" && m !== "tools/call") {
        methods.push(m);
      }
    }
  }
  return methods;
}

function sessionIdOf(req: IncomingMessage): string | undefined {
  const raw = req.headers[SESSION_HEADER];
  if (Array.isArray(raw)) return raw[0];
  return raw;
}

function hasInitializeMessage(parsed: unknown): boolean {
  const messages = Array.isArray(parsed) ? parsed : [parsed];
  return messages.some(
    (message) =>
      typeof message === "object" &&
      message !== null &&
      (message as { method?: unknown }).method === "initialize",
  );
}

async function releaseSession(
  session: Session,
  sessions: Map<string, Session>,
  reason: "client" | "idle" | "shutdown" | "init_failed" = "client",
  onForget?: (id: string) => void,
): Promise<void> {
  const sid = session.id;
  if (sid) {
    sessions.delete(sid);
    if (reason === "client" || reason === "idle") {
      onForget?.(sid);
    }
  }
  if (session.closed) return;
  session.closed = true;
  if (sid) {
    logInfo("session.close", { sid: sid.slice(0, 8), reason, active: sessions.size });
  }
  try {
    await session.server.close();
  } catch {
    // 连接已经断开，这里不需要再报
  }
}

function createSession(
  config: AppConfig,
  sessions: Map<string, Session>,
  baseUrl: string,
  onRemember: (id: string) => void,
  onForget: (id: string) => void,
): Session {
  let session!: Session;
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (id) => {
      session.id = id;
      sessions.set(id, session);
      onRemember(id);
    },
    onsessionclosed: () => {
      void releaseSession(session, sessions, "client", onForget);
    },
  });
  transport.onclose = () => {
    // 仅客户端显式 DELETE（onsessionclosed）或空闲回收才遗忘持久化会话；
    // 停机/重启触发的底层连接关闭走 shutdown，保留 persistedSessions 以便重启后透明恢复。
    void releaseSession(session, sessions, "shutdown");
  };
  transport.onerror = (error) => {
    logWarn("session.error", {
      sid: session.id ? session.id.slice(0, 8) : "init",
      err: error.message,
    });
  };
  session = {
    server: createServer(config, { sessionId: () => session.id, baseUrl }),
    transport,
    closed: false,
    lastSeen: Date.now(),
  };
  return session;
}

function loadPersistedSessions(storePath: string): Map<string, number> {
  const map = new Map<string, number>();
  if (!existsSync(storePath)) return map;
  try {
    const raw = JSON.parse(readFileSync(storePath, "utf8")) as Record<string, unknown>;
    const now = Date.now();
    for (const [sid, ts] of Object.entries(raw)) {
      if (typeof ts === "number" && now - ts <= IDLE_SESSION_MS) {
        map.set(sid, ts);
      }
    }
  } catch {
    // 损坏文件忽略，按空表启动
  }
  return map;
}

function savePersistedSessions(storePath: string, map: Map<string, number>): void {
  try {
    mkdirSync(path.dirname(storePath), { recursive: true });
    const obj: Record<string, number> = {};
    for (const [sid, ts] of map) {
      obj[sid] = ts;
    }
    writeFileSync(storePath, `${JSON.stringify(obj, null, 2)}\n`, "utf8");
  } catch {
    // 落盘失败不阻断正常请求
  }
}

export function createMcpService(config: AppConfig): McpService {
  const sessions = new Map<string, Session>();
  let listener: Server | undefined;
  let actualPort = config.port;
  let ready = false;
  let sweeper: NodeJS.Timeout | undefined;

  /** 对外公布的 base：配了隧道用隧道地址，否则本机地址；OAuth 元数据与授权入口都从这里拼 */
  function publicBaseUrl(): string {
    const tunnel = config.tunnelUrl?.trim();
    if (tunnel) {
      const withProto = /^https?:\/\//i.test(tunnel) ? tunnel : `https://${tunnel}`;
      return withProto.replace(/\/+$/, "");
    }
    return `http://127.0.0.1:${actualPort}`;
  }

  // OAuth 与活跃会话索引均与 config.json 放同一目录，热切换重启后可透明恢复未关闭的历史会话
  const configDir = path.dirname(configFilePath());
  const oauthStorePath = path.join(configDir, "oauth-store.json");
  const sessionsStorePath = path.join(configDir, "sessions-store.json");
  const persistedSessions = loadPersistedSessions(sessionsStorePath);
  const resumedLogged = new Set<string>();

  function rememberSession(id: string): void {
    persistedSessions.set(id, Date.now());
    savePersistedSessions(sessionsStorePath, persistedSessions);
  }

  function forgetSession(id: string): void {
    resumedLogged.delete(id);
    if (persistedSessions.delete(id)) {
      savePersistedSessions(sessionsStorePath, persistedSessions);
    }
  }

  function hasValidPersistedSession(id: string): boolean {
    const ts = persistedSessions.get(id);
    if (ts === undefined) return false;
    if (Date.now() - ts > IDLE_SESSION_MS) {
      forgetSession(id);
      return false;
    }
    return true;
  }

  const oauth = new OAuthProvider({
    approvalSecret: () => config.token,
    publicBaseUrl,
    storePath: oauthStorePath,
  });

  function url(): string {
    return `http://${LISTEN_HOST}:${actualPort}${MCP_PATH}`;
  }

  /** 任何要写日志或回给客户端的动态文本都先过这道，防止令牌从查询串之类的地方漏出去 */
  function safeText(message: string): string {
    return redactText(message, config.token);
  }

  function sweepIdleSessions(): void {
    const now = Date.now();
    for (const session of [...sessions.values()]) {
      if (now - session.lastSeen > IDLE_SESSION_MS) {
        void releaseSession(session, sessions, "idle", forgetSession);
      }
    }
    let changed = false;
    for (const [sid, ts] of [...persistedSessions]) {
      if (now - ts > IDLE_SESSION_MS) {
        persistedSessions.delete(sid);
        resumedLogged.delete(sid);
        changed = true;
      }
    }
    if (changed) savePersistedSessions(sessionsStorePath, persistedSessions);
  }

  async function handleResumedPost(
    req: IncomingMessage,
    res: ServerResponse,
    parsed: unknown,
    sessionId: string,
  ): Promise<void> {
    persistedSessions.set(sessionId, Date.now());
    if (!resumedLogged.has(sessionId)) {
      resumedLogged.add(sessionId);
      logInfo("session.resume", { sid: sessionId.slice(0, 8) });
    }
    for (const rpcMethod of rpcControlMethods(parsed)) {
      logDebug("mcp.rpc", { sid: sessionId.slice(0, 8), method: rpcMethod });
    }
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const server = createServer(config, { sessionId: () => sessionId, baseUrl: publicBaseUrl() });
    await server.connect(transport);
    res.setHeader(SESSION_HEADER, sessionId);
    try {
      await transport.handleRequest(req, res, parsed);
    } finally {
      await server.close().catch(() => undefined);
    }
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const requestUrl = new URL(req.url ?? "/", "http://localhost");

    // OAuth 元数据 / 注册 / 授权 / 令牌端点先于 MCP 端点处理
    if (await oauth.handle(req, res, requestUrl.pathname, requestUrl)) {
      return;
    }

    // 健康检查在鉴权之前：暴露服务存活与非敏感运行指纹，不带任何凭据
    if (requestUrl.pathname === HEALTH_PATH) {
      sendJson(res, 200, { ok: true, service: "nexus-mcp", ...getRuntimeIdentity() });
      return;
    }

    // 静态图标在鉴权之前：供云端连接器与浏览器抓取 /favicon.ico 等路径，不刷日志
    if (handleIconRequest(req, res, requestUrl.pathname)) {
      return;
    }

    if (requestUrl.pathname !== MCP_PATH) {
      sendJson(res, 404, {
        error: `MCP 端点只有 ${MCP_PATH}，当前请求的是 ${requestUrl.pathname}`,
      });
      return;
    }

    const auth = checkAuth(req, config, oauth);
    if (auth) {
      logWarn("auth.deny", { status: auth.status, reason: auth.reason });
      const headers: Record<string, string> = {};
      if (auth.status === 401) headers["WWW-Authenticate"] = oauth.wwwAuthenticate(auth.oauthError);
      sendRpcError(res, auth.status, RPC_AUTH_FAILED, auth.message, headers);
      return;
    }

    const method = req.method ?? "GET";
    if (method !== "POST" && method !== "GET" && method !== "DELETE") {
      sendRpcError(res, 405, RPC_INVALID_REQUEST, `MCP 端点不接受 ${method}`, {
        Allow: "GET, POST, DELETE",
      });
      return;
    }

    const sessionId = sessionIdOf(req);

    if (method === "POST") {
      let raw: string;
      try {
        raw = await readBody(req, MAX_BODY_BYTES);
      } catch (error) {
        sendRpcError(res, 413, RPC_INVALID_REQUEST, (error as Error).message);
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        sendRpcError(res, 400, RPC_PARSE_ERROR, "请求体不是合法 JSON。");
        return;
      }

      if (sessionId) {
        const existing = sessions.get(sessionId);
        if (!existing) {
          if (hasValidPersistedSession(sessionId)) {
            await handleResumedPost(req, res, parsed, sessionId);
            return;
          }
          sendSessionNotFound(res, sessionId, method);
          return;
        }
        existing.lastSeen = Date.now();
        persistedSessions.set(sessionId, existing.lastSeen);
        for (const rpcMethod of rpcControlMethods(parsed)) {
          logDebug("mcp.rpc", { sid: sessionId.slice(0, 8), method: rpcMethod });
        }
        await existing.transport.handleRequest(req, res, parsed);
        return;
      }

      if (!hasInitializeMessage(parsed)) {
        sendRpcError(res, 400, RPC_INVALID_REQUEST, `缺少 ${SESSION_HEADER} 头，只有 initialize 请求可以不带头。`);
        return;
      }

      for (const rpcMethod of rpcControlMethods(parsed)) {
        logDebug("mcp.rpc", { sid: "init", method: rpcMethod });
      }
      const session = createSession(
        config,
        sessions,
        publicBaseUrl(),
        rememberSession,
        forgetSession,
      );
      await session.server.connect(session.transport);
      await session.transport.handleRequest(req, res, parsed);
      if (session.id) {
        logInfo("session.open", { sid: session.id.slice(0, 8), active: sessions.size });
      } else {
        // initialize 没走完（客户端中断或协议错误），别把孤儿实例留在表外
        await releaseSession(session, sessions, "init_failed", forgetSession);
      }
      return;
    }

    if (!sessionId) {
      sendRpcError(res, 400, RPC_INVALID_REQUEST, `缺少 ${SESSION_HEADER} 头。`);
      return;
    }
    const existing = sessions.get(sessionId);
    if (!existing) {
      if (method === "DELETE" && hasValidPersistedSession(sessionId)) {
        forgetSession(sessionId);
        res.writeHead(200);
        res.end();
        return;
      }
      sendSessionNotFound(res, sessionId, method);
      return;
    }
    existing.lastSeen = Date.now();
    if (method === "GET") {
      const sidShort = sessionId.slice(0, 8);
      logDebug("sse.open", { sid: sidShort });
      res.once("close", () => {
        logDebug("sse.close", { sid: sidShort });
      });
    }
    await existing.transport.handleRequest(req, res);
  }

  async function start(): Promise<void> {
    if (listener) return;

    const server = http.createServer((req, res) => {
      route(req, res).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        logError("service.error", { err: safeText(message) });
        if (res.headersSent) {
          res.end();
          return;
        }
        sendRpcError(res, 500, RPC_INTERNAL_ERROR, `服务内部错误: ${safeText(message)}`);
      });
    });

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      server.once("error", onError);
      server.listen(config.port, LISTEN_HOST, () => {
        server.off("error", onError);
        resolve();
      });
    });

    listener = server;
    const address = server.address();
    actualPort = typeof address === "object" && address ? address.port : config.port;
    ready = true;
    sweeper = setInterval(() => sweepIdleSessions(), SESSION_SWEEP_MS);
    sweeper.unref();
    logInfo("service.start", {
      url: url(),
      auth: config.token ? "bearer+oauth" : "loopback_only",
    });
  }

  async function stop(options?: { preserveSessions?: boolean }): Promise<void> {
    const preserveSessions = options?.preserveSessions === true;
    const current = listener;
    listener = undefined;
    ready = false;
    if (sweeper) {
      clearInterval(sweeper);
      sweeper = undefined;
    }

    if (current) {
      await new Promise<void>((resolve) => {
        current.close(() => resolve());
        current.closeAllConnections();
      });
    }

    for (const session of [...sessions.values()]) {
      await releaseSession(session, sessions, "shutdown");
    }
    sessions.clear();
    if (!preserveSessions) {
      persistedSessions.clear();
      resumedLogged.clear();
    }
    savePersistedSessions(sessionsStorePath, persistedSessions);
    await closeExecutor();

    if (current) logInfo("service.stop", { url: url() });
  }

  return {
    start,
    stop,
    isRunning: () => ready,
    port: () => actualPort,
    url,
    sessionCount: () => sessions.size,
    oauthInfo: () => ({ available: oauth.oauthEnabled(), url: oauth.authorizeUrl() }),
  };
}
