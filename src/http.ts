import { randomUUID, timingSafeEqual } from "node:crypto";
import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppConfig } from "./config.js";
import { createServer } from "./server.js";

const MCP_PATH = "/mcp";
/** 请求体上限，与传输层默认值一致；超出直接 413，不进入解析 */
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const LISTEN_HOST = "127.0.0.1";
const SESSION_HEADER = "mcp-session-id";

interface Session {
  id?: string;
  server: McpServer;
  transport: StreamableHTTPServerTransport;
  closed: boolean;
}

export interface HttpServerHandle {
  port: number;
  url: string;
  close(): Promise<void>;
}

/** 日志只走 stderr，且只记录方法与状态；令牌、Authorization 头一律不进日志 */
function log(message: string): void {
  console.error(`[nexus-mcp] ${message}`);
}

function isLoopback(address: string | undefined): boolean {
  if (!address) return false;
  if (address === "::1") return true;
  return address === "127.0.0.1" || address.startsWith("127.") || address.startsWith("::ffff:127.");
}

function tokenEquals(given: string, expected: string): boolean {
  const left = Buffer.from(given, "utf8");
  const right = Buffer.from(expected, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

interface AuthFailure {
  status: number;
  message: string;
}

function checkAuth(req: IncomingMessage, config: AppConfig): AuthFailure | null {
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
  if (!tokenEquals(value, config.token)) {
    return { status: 401, message: "Bearer 令牌不正确。" };
  }
  return null;
}

function sendJson(
  res: ServerResponse,
  status: number,
  payload: unknown,
  headers: Record<string, string> = {},
): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    ...headers,
  });
  res.end(body);
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

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error(`请求体超过 ${MAX_BODY_BYTES} 字节`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
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
  session = { server: createServer(config), transport, closed: false };
  return session;
}

export async function startHttpServer(
  config: AppConfig,
  port: number = config.port,
): Promise<HttpServerHandle> {
  const sessions = new Map<string, Session>();

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== MCP_PATH) {
      sendJson(res, 404, {
        error: `MCP 端点只有 ${MCP_PATH}，当前请求的是 ${url.pathname}`,
      });
      return;
    }

    const auth = checkAuth(req, config);
    if (auth) {
      sendRpcError(res, auth.status, -32001, auth.message, {
        "WWW-Authenticate": 'Bearer realm="nexus-mcp"',
      });
      return;
    }

    const method = req.method ?? "GET";
    if (method !== "POST" && method !== "GET" && method !== "DELETE") {
      sendRpcError(res, 405, -32600, `MCP 端点不接受 ${method}`, {
        Allow: "GET, POST, DELETE",
      });
      return;
    }

    const sessionId = sessionIdOf(req);

    if (method === "POST") {
      let raw: string;
      try {
        raw = await readBody(req);
      } catch (error) {
        sendRpcError(res, 413, -32600, (error as Error).message);
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        sendRpcError(res, 400, -32700, "请求体不是合法 JSON。");
        return;
      }

      if (sessionId) {
        const existing = sessions.get(sessionId);
        if (!existing) {
          sendRpcError(res, 404, -32001, "会话不存在或已结束，请重新 initialize。");
          return;
        }
        await existing.transport.handleRequest(req, res, parsed);
        return;
      }

      if (!hasInitializeMessage(parsed)) {
        sendRpcError(res, 400, -32600, `缺少 ${SESSION_HEADER} 头，只有 initialize 请求可以不带头。`);
        return;
      }

      const session = createSession(config, sessions);
      await session.server.connect(session.transport);
      await session.transport.handleRequest(req, res, parsed);
      if (session.id) {
        log(`会话已建立 ${session.id}，当前 ${sessions.size} 个`);
      }
      return;
    }

    if (!sessionId) {
      sendRpcError(res, 400, -32600, `缺少 ${SESSION_HEADER} 头。`);
      return;
    }
    const existing = sessions.get(sessionId);
    if (!existing) {
      sendRpcError(res, 404, -32001, "会话不存在或已结束，请重新 initialize。");
      return;
    }
    await existing.transport.handleRequest(req, res);
  }

  const server = http.createServer((req, res) => {
    route(req, res).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      log(`请求处理失败: ${message}`);
      if (res.headersSent) {
        res.end();
        return;
      }
      sendRpcError(res, 500, -32603, `服务内部错误: ${message}`);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, LISTEN_HOST, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  const url = `http://${LISTEN_HOST}:${actualPort}${MCP_PATH}`;

  log(
    config.token
      ? `HTTP 已就绪: ${url}（已启用 Bearer 校验）`
      : `HTTP 已就绪: ${url}（未配置令牌，只接受本机连接）`,
  );

  return {
    port: actualPort,
    url,
    async close() {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      for (const session of [...sessions.values()]) {
        await releaseSession(session, sessions);
      }
      sessions.clear();
    },
  };
}
