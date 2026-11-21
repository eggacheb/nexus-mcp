import { existsSync, statSync } from "node:fs";
import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import type { AppConfig } from "./config.js";
import { loadConfig, saveConfig } from "./config.js";
import { readBody, sendJson as sendJsonRaw } from "./httpHelpers.js";
import { log, recentLogs, redactText } from "./log.js";
import type { McpService } from "./mcpService.js";
import type { ComponentStatus } from "./status.js";
import { executorStatus, probeTunnel } from "./status.js";

const LISTEN_HOST = "127.0.0.1";
const MAX_BODY_BYTES = 64 * 1024;

export interface PanelStatus {
  service: {
    state: "running" | "stopped";
    label: string;
    port: number;
    url: string;
    sessions: number;
  };
  executor: ComponentStatus;
  tunnel: ComponentStatus;
  root: string;
  oauth: { url: string; available: boolean };
  panelPort: number;
}

export interface PanelHandle {
  port: number;
  url: string;
  close(): Promise<void>;
}

const PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>nexus-mcp 控制面板</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; background: #0e1116; color: #e6edf3;
    font: 14px/1.6 system-ui, "Segoe UI", "Microsoft YaHei", sans-serif;
  }
  main {
    max-width: 1080px; margin: 0 auto; padding: 28px 24px 40px;
    display: grid; gap: 14px; grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  header { grid-column: 1 / -1; display: flex; align-items: baseline; gap: 12px; }
  h1 { margin: 0; font-size: 20px; letter-spacing: .3px; }
  h2 { margin: 0 0 10px; font-size: 13px; font-weight: 600; color: #8b98a8; letter-spacing: .4px; text-transform: uppercase; }
  h2 small { font-weight: 400; text-transform: none; letter-spacing: 0; }
  .card { background: #151a21; border: 1px solid #232b36; border-radius: 10px; padding: 16px; }
  .wide { grid-column: 1 / -1; }
  .lights { display: grid; gap: 10px; }
  .light { display: flex; align-items: center; gap: 10px; }
  .light b { font-weight: 600; }
  .light small { display: block; color: #8b98a8; font-size: 12px; }
  .dot { width: 9px; height: 9px; border-radius: 50%; background: #55606e; box-shadow: 0 0 0 4px rgba(85,96,110,.15); flex: none; }
  .light[data-state="up"] .dot,
  .light[data-state="running"] .dot { background: #3fb950; box-shadow: 0 0 0 4px rgba(63,185,80,.16); }
  .light[data-state="down"] .dot,
  .light[data-state="stopped"] .dot { background: #f85149; box-shadow: 0 0 0 4px rgba(248,81,73,.16); }
  .light[data-state="unavailable"] .dot,
  .light[data-state="unconfigured"] .dot { background: #d29922; box-shadow: 0 0 0 4px rgba(210,153,34,.16); }
  .row { display: flex; gap: 8px; }
  input {
    flex: 1; min-width: 0; background: #0e1116; color: #e6edf3; border: 1px solid #2b3440;
    border-radius: 7px; padding: 8px 10px; font: inherit; font-family: ui-monospace, Consolas, monospace;
  }
  button {
    background: #1f6feb; color: #fff; border: 0; border-radius: 7px; padding: 8px 14px;
    font: inherit; cursor: pointer;
  }
  button.ghost { background: #21262d; border: 1px solid #30363d; }
  button:hover { filter: brightness(1.1); }
  a { color: #58a6ff; }
  .hint { margin: 8px 0 0; color: #8b98a8; font-size: 12px; }
  pre {
    margin: 0; height: 200px; overflow: auto; background: #0b0e12; border: 1px solid #1e252e;
    border-radius: 7px; padding: 10px; font: 12px/1.55 ui-monospace, Consolas, monospace;
    white-space: pre-wrap; word-break: break-all; color: #b8c4d0;
  }
  @media (max-width: 720px) { main { grid-template-columns: 1fr; } }
</style>
</head>
<body>
<main>
  <header>
    <h1>nexus-mcp</h1>
    <span class="hint" style="margin:0">本地控制面板 · 停 MCP 服务不影响这块页面</span>
  </header>

  <section class="card" data-block="status">
    <h2>状态</h2>
    <div class="lights">
      <div class="light" id="light-executor" data-state="unavailable">
        <span class="dot"></span><div><b>执行器</b><small>读取中…</small></div>
      </div>
      <div class="light" id="light-resource-mcp" data-state="down">
        <span class="dot"></span><div><b>MCP 服务</b><small>读取中…</small></div>
      </div>
      <div class="light" id="light-tunnel" data-state="unconfigured">
        <span class="dot"></span><div><b>隧道</b><small>读取中…</small></div>
      </div>
    </div>
  </section>

  <section class="card" data-block="address">
    <h2>MCP 地址</h2>
    <div class="row">
      <input id="mcp-url" readonly value="读取中…" />
      <button id="copy">复制</button>
    </div>
    <p class="hint" id="mcp-hint">—</p>
  </section>

  <section class="card" data-block="oauth">
    <h2>授权</h2>
    <a id="oauth-link" aria-disabled="true">OAuth 授权入口</a>
    <p class="hint" id="oauth-hint">—</p>
  </section>

  <section class="card" data-block="root">
    <h2>根目录</h2>
    <div class="row">
      <input id="root-path" value="" />
      <button id="save-root">保存</button>
    </div>
    <p class="hint">改完立即生效，同时写回 config.json</p>
  </section>

  <section class="card wide" data-block="logs">
    <h2>最近日志 <small>最近 100 行，令牌已抹掉</small></h2>
    <pre id="logs">读取中…</pre>
  </section>

  <section class="card" data-block="controls">
    <h2>服务</h2>
    <div class="row">
      <button id="stop">停止</button>
      <button id="start">启动</button>
      <button id="reload" class="ghost">重载配置</button>
    </div>
    <p class="hint" id="control-hint">—</p>
  </section>
</main>
<script>
  var rootInput = document.getElementById("root-path");
  var logBox = document.getElementById("logs");

  function setLight(id, status) {
    var box = document.getElementById(id);
    if (!box || !status) return;
    box.dataset.state = status.state;
    box.querySelector("small").textContent = status.detail
      ? status.label + " · " + status.detail
      : status.label;
  }

  function applyStatus(s) {
    setLight("light-executor", s.executor);
    setLight("light-resource-mcp", s.service);
    setLight("light-tunnel", s.tunnel);
    document.getElementById("mcp-url").value = s.service.url;
    document.getElementById("mcp-hint").textContent =
      "状态：" + s.service.label + " · 端口 " + s.service.port + " · 会话 " + s.service.sessions + " 个";
    var oauthLink = document.getElementById("oauth-link");
    if (s.oauth.available) {
      oauthLink.setAttribute("href", s.oauth.url);
      oauthLink.removeAttribute("aria-disabled");
    } else {
      oauthLink.removeAttribute("href");
      oauthLink.setAttribute("aria-disabled", "true");
    }
    document.getElementById("oauth-hint").textContent = s.oauth.available
      ? "已启用"
      : "OAuth 尚未接入，云端先用 Bearer 令牌";
    if (document.activeElement !== rootInput) rootInput.value = s.root;
    document.getElementById("control-hint").textContent = "面板端口 " + s.panelPort;
  }

  async function refresh() {
    try {
      var res = await fetch("/api/status", { cache: "no-store" });
      if (res.ok) applyStatus(await res.json());
    } catch (error) { /* 面板自己还在，忽略这一轮 */ }
  }

  async function refreshLogs() {
    try {
      var res = await fetch("/api/logs", { cache: "no-store" });
      if (!res.ok) return;
      var body = await res.json();
      var atBottom = logBox.scrollTop + logBox.clientHeight >= logBox.scrollHeight - 24;
      logBox.textContent = body.lines.length ? body.lines.join("\\n") : "（还没有日志）";
      if (atBottom) logBox.scrollTop = logBox.scrollHeight;
    } catch (error) { /* 同上 */ }
  }

  async function post(path, body) {
    var res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    var data = null;
    try { data = await res.json(); } catch (error) { data = null; }
    if (!res.ok) {
      alert((data && data.error) || ("请求失败：HTTP " + res.status));
      return false;
    }
    if (data && data.service) applyStatus(data);
    await refreshLogs();
    return true;
  }

  document.getElementById("copy").addEventListener("click", async function () {
    var input = document.getElementById("mcp-url");
    var text = input.value;
    try {
      await navigator.clipboard.writeText(text);
    } catch (error) {
      input.removeAttribute("readonly");
      input.select();
      document.execCommand("copy");
      input.setAttribute("readonly", "readonly");
    }
    this.textContent = "已复制";
    var button = this;
    setTimeout(function () { button.textContent = "复制"; }, 1200);
  });

  document.getElementById("save-root").addEventListener("click", function () {
    post("/api/root", { root: rootInput.value });
  });

  document.getElementById("stop").addEventListener("click", function () {
    post("/api/service", { action: "stop" });
  });
  document.getElementById("start").addEventListener("click", function () {
    post("/api/service", { action: "start" });
  });
  document.getElementById("reload").addEventListener("click", function () {
    post("/api/service", { action: "reload" });
  });

  refresh();
  refreshLogs();
  setInterval(function () { refresh(); refreshLogs(); }, 5000);
</script>
</body>
</html>
`;

/** 面板的 JSON 响应一律 no-store，状态和日志不允许被中间层缓存 */
function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  sendJsonRaw(res, status, payload, { "Cache-Control": "no-store" });
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readBody(req, MAX_BODY_BYTES);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("请求体不是合法 JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("请求体必须是 JSON 对象");
  }
  return parsed as Record<string, unknown>;
}

/**
 * 只认本面板自己的 Origin；浏览器发简单请求时也拦住表单式 POST。
 * 返回 true 表示已经拒绝并写完响应，调用方直接 return。
 */
function blockUnsafeWrite(req: IncomingMessage, res: ServerResponse, panelPort: number): boolean {
  const origin = req.headers.origin;
  const allowed = new Set([
    `http://${LISTEN_HOST}:${panelPort}`,
    `http://localhost:${panelPort}`,
  ]);
  if (origin && !allowed.has(origin)) {
    sendJson(res, 403, { error: "拒绝跨站写操作" });
    return true;
  }
  if (req.headers["sec-fetch-site"] === "cross-site") {
    sendJson(res, 403, { error: "拒绝跨站写操作" });
    return true;
  }
  const type = String(req.headers["content-type"] ?? "")
    .split(";")[0]
    ?.trim()
    .toLowerCase();
  if (type !== "application/json") {
    sendJson(res, 415, { error: "写操作只接受 application/json" });
    return true;
  }
  return false;
}

export async function startPanel(config: AppConfig, service: McpService): Promise<PanelHandle> {
  let panelPort = config.panelPort;

  async function statusPayload(): Promise<PanelStatus> {
    const running = service.isRunning();
    return {
      service: {
        state: running ? "running" : "stopped",
        label: running ? "运行中" : "已停止",
        port: service.port(),
        url: service.url(),
        sessions: service.sessionCount(),
      },
      executor: executorStatus(),
      tunnel: await probeTunnel(config),
      root: config.root,
      oauth: { url: "/oauth/authorize", available: false },
      panelPort,
    };
  }

  /** Host 只认本机两个名字：挡掉 DNS rebinding 借道的页面 */
  function hostAllowed(req: IncomingMessage): boolean {
    const host = req.headers.host;
    if (!host) return false;
    return (
      host === `${LISTEN_HOST}:${panelPort}` ||
      host === `localhost:${panelPort}` ||
      host === `[::1]:${panelPort}`
    );
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");

    if (!hostAllowed(req)) {
      sendJson(res, 403, { error: `面板只接受本机 Host，收到 ${req.headers.host ?? "(空)"}` });
      return;
    }

    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(PAGE);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/status") {
      sendJson(res, 200, await statusPayload());
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/logs") {
      const token = config.token;
      sendJson(res, 200, { lines: recentLogs().map((line) => redactText(line, token)) });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/root") {
      if (blockUnsafeWrite(req, res, panelPort)) return;
      let body: Record<string, unknown>;
      try {
        body = await readJson(req);
      } catch (error) {
        sendJson(res, 400, { error: (error as Error).message });
        return;
      }
      const input = typeof body.root === "string" ? body.root.trim() : "";
      if (!input) {
        sendJson(res, 400, { error: "root 不能为空" });
        return;
      }
      // 相对路径按进程 cwd 解析会得到意外结果，这里只要绝对路径
      if (!path.isAbsolute(input)) {
        sendJson(res, 400, { error: `root 需要绝对路径，收到的是 ${input}` });
        return;
      }
      const abs = path.resolve(input);
      if (!existsSync(abs) || !statSync(abs).isDirectory()) {
        sendJson(res, 400, { error: `目录不存在: ${abs}` });
        return;
      }
      config.root = abs;
      saveConfig(config);
      log(`根目录已切换到 ${abs}`);
      sendJson(res, 200, await statusPayload());
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/service") {
      if (blockUnsafeWrite(req, res, panelPort)) return;
      let body: Record<string, unknown>;
      try {
        body = await readJson(req);
      } catch (error) {
        sendJson(res, 400, { error: (error as Error).message });
        return;
      }
      const action = typeof body.action === "string" ? body.action : "";

      try {
        if (action === "stop") {
          await service.stop();
          log("面板操作: 停止 MCP 服务");
        } else if (action === "start") {
          await service.start();
          log("面板操作: 启动 MCP 服务");
        } else if (action === "reload") {
          const next = loadConfig();
          Object.assign(config, next);
          log(`配置已重载，根目录 ${config.root}`);
          if (next.panelPort !== panelPort) {
            log(`panelPort 改成 ${next.panelPort}，面板需要重启进程才生效`);
          }
          if (service.isRunning()) {
            await service.stop();
            await service.start();
          }
        } else {
          sendJson(res, 400, { error: `未知操作: ${action}` });
          return;
        }
      } catch (error) {
        sendJson(res, 500, { error: `操作失败: ${(error as Error).message}` });
        return;
      }

      sendJson(res, 200, await statusPayload());
      return;
    }

    sendJson(res, 404, { error: `没有这个接口: ${url.pathname}` });
  }

  const server = http.createServer((req, res) => {
    route(req, res).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      const safeMessage = redactText(message, config.token);
      log(`面板请求失败: ${safeMessage}`);
      if (res.headersSent) {
        res.end();
        return;
      }
      sendJson(res, 500, { error: `面板内部错误: ${safeMessage}` });
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) =>
      reject(
        new Error(
          `面板端口 ${config.panelPort} 绑定失败: ${error.message}。改 config.json 的 panelPort 或关掉占用它的程序。`,
        ),
      );
    server.once("error", onError);
    server.listen(config.panelPort, LISTEN_HOST, () => {
      server.off("error", onError);
      resolve();
    });
  });

  const address = server.address();
  panelPort = typeof address === "object" && address ? address.port : config.panelPort;
  log(`面板已就绪: http://${LISTEN_HOST}:${panelPort}`);

  return {
    port: panelPort,
    url: `http://${LISTEN_HOST}:${panelPort}`,
    async close() {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
}
