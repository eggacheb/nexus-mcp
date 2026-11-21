import { randomUUID } from "node:crypto";
import http from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import path from "node:path";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppConfig } from "./config.js";
import { configFilePath } from "./config.js";
import { readBody, sendJson } from "./httpHelpers.js";
import { log, redactText } from "./log.js";
import { OAuthProvider, safeEqual } from "./oauth.js";
import { createServer } from "./server.js";

const MCP_PATH = "/mcp";
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
  stop(): Promise<void>;
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

interface AuthFailure {
  status: number;
  message: string;
  /** 令牌无效时带给 WWW-Authenticate 的 OAuth 错误码（RFC 6750） */
  oauthError?: string;
}

/** 日志只记录方法与状态；令牌、Authorization 头一律不进日志 */
function checkAuth(req: IncomingMessage, config: AppConfig, oauth: OAuthProvider): AuthFailure | null {
  const remote = req.socket.remoteAddress;

  if (!config.token) {
    if (!isLoopback(remote)) {
      return {
        status: 403,
        message: `配置里没有令牌，只接受本机连接；拒绝来自 ${remote ?? "未知地址"} 的请求。`,
      };
    }
    return null;
  }

  const header = req.headers.authorization;
  if (!header) {
    return { status: 401, message: "缺少 Authorization 请求头，需要 Bearer 令牌。" };
  }
  const [scheme, value] = header.split(" ");
  if (!scheme || scheme.toLowerCase() !== "bearer" || !value) {
    return { status: 401, message: "Authorization 头格式不对，需要写成 Bearer <令牌>。" };
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

function sendSessionNotFound(res: ServerResponse): void {
  sendRpcError(res, 404, RPC_SESSION_GONE, "会话不存在或已结束，请重新 initialize。");
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

async function releaseSession(session: Session, sessions: Map<string, Session>): Promise<void> {
  if (session.id) sessions.delete(session.id);
  if (session.closed) return;
  session.closed = true;
  try {
    await session.server.close();
  } catch {
    // 连接已经断开，这里不需要再报
  }
}

function createSession(config: AppConfig, sessions: Map<string, Session>): Session {
  let session!: Session;
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (id) => {
      session.id = id;
      sessions.set(id, session);
    },
    onsessionclosed: () => {
      void releaseSession(session, sessions);
    },
  });
  transport.onclose = () => {
    void releaseSession(session, sessions);
  };
  transport.onerror = (error) => {
    log(`会话出错: ${error.message}`);
  };
  session = { server: createServer(config), transport, closed: false, lastSeen: Date.now() };
  return session;
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

  // OAuth 数据与 config.json 放同一目录，分发时一个目录全带走
  const oauthStorePath = path.join(path.dirname(configFilePath()), "oauth-store.json");
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
        log(`回收空闲会话 ${safeText(session.id ?? "(未完成初始化)")}`);
        void releaseSession(session, sessions);
      }
    }
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const requestUrl = new URL(req.url ?? "/", "http://localhost");

    // OAuth 元数据 / 注册 / 授权 / 令牌端点先于 MCP 端点处理
    if (await oauth.handle(req, res, requestUrl.pathname, requestUrl)) {
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
          sendSessionNotFound(res);
          return;
        }
        existing.lastSeen = Date.now();
        await existing.transport.handleRequest(req, res, parsed);
        return;
      }

      if (!hasInitializeMessage(parsed)) {
        sendRpcError(res, 400, RPC_INVALID_REQUEST, `缺少 ${SESSION_HEADER} 头，只有 initialize 请求可以不带头。`);
        return;
      }

      const session = createSession(config, sessions);
      await session.server.connect(session.transport);
      await session.transport.handleRequest(req, res, parsed);
      if (session.id) {
        log(`会话已建立 ${session.id}，当前 ${sessions.size} 个`);
      } else {
        // initialize 没走完（客户端中断或协议错误），别把孤儿实例留在表外
        await releaseSession(session, sessions);
      }
      return;
    }

    if (!sessionId) {
      sendRpcError(res, 400, RPC_INVALID_REQUEST, `缺少 ${SESSION_HEADER} 头。`);
      return;
    }
    const existing = sessions.get(sessionId);
    if (!existing) {
      sendSessionNotFound(res);
      return;
    }
    existing.lastSeen = Date.now();
    await existing.transport.handleRequest(req, res);
  }

  async function start(): Promise<void> {
    if (listener) return;

    const server = http.createServer((req, res) => {
      route(req, res).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        log(`请求处理失败: ${safeText(message)}`);
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
    log(
      config.token
        ? `MCP 端点已就绪: ${url()}（已启用 Bearer 校验与 OAuth 2.1，数据落盘 ${oauthStorePath}）`
        : `MCP 端点已就绪: ${url()}（未配置令牌，只接受本机连接）`,
    );
  }

  async function stop(): Promise<void> {
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
      await releaseSession(session, sessions);
    }
    sessions.clear();

    if (current) log("MCP 端点已停止");
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
