import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import type { AppConfig } from "./config.js";
import {
  loadConfig,
  normalizeCommandPolicy,
  normalizeLogLevel,
  normalizePositiveInt,
  normalizeTunnelUrl,
  replaceConfigInPlace,
  saveConfig,
  validateShell,
} from "./config.js";
import { readBody, sendJson as sendJsonRaw } from "./httpHelpers.js";
import { logError, logInfo, logWarn, recentLogs, redactText, setLogLevel } from "./log.js";
import type { McpService } from "./mcpService.js";
import type { ComponentStatus, TunnelStatus } from "./status.js";
import { executorStatus, probePublicTunnel, tunnelStatus } from "./status.js";
import { TOOL_SUMMARY } from "./tools.js";
import { TunnelManager, resolveTunnelOptions } from "./tunnel.js";
import { VERSION } from "./version.js";

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
  tunnel: TunnelStatus;
  root: string;
  panelPort: number;
  /** 程序版本，页头直接显示；与安装包文件名、package.json 同源 */
  version: string;
}

export interface PanelHandle {
  port: number;
  url: string;
  close(): Promise<void>;
}

const TOOL_ITEMS = TOOL_SUMMARY.map(
  (tool) => `<li><b>${tool.name}</b><span>${tool.summary}</span></li>`,
).join("\n      ");

const PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>nexus-mcp 控制面板</title>
<style>
  :root {
    color-scheme: light;
    --bg: #f5f6f8; --card: #ffffff; --line: #e4e7ec; --text: #1f2328; --muted: #667085;
    --brand: #2563eb; --ok: #16a34a; --warn: #d97706; --bad: #dc2626;
    --mono: ui-monospace, "Cascadia Mono", Consolas, monospace;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; background: var(--bg); color: var(--text);
    font: 14px/1.6 system-ui, "Segoe UI", "Microsoft YaHei", sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  main {
    max-width: 1440px; margin: 0 auto; padding: 24px 28px 56px;
    display: grid; gap: 16px; grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  header { grid-column: 1 / -1; display: flex; align-items: baseline; flex-wrap: wrap; gap: 10px; }
  h1 { margin: 0; font-size: 20px; font-weight: 650; letter-spacing: .2px; }
  .tag { font-size: 12px; color: var(--muted); }
  h2 {
    margin: 0 0 14px; font-size: 12px; font-weight: 600; color: var(--muted);
    letter-spacing: .6px; text-transform: uppercase;
  }
  h2 small { font-weight: 400; text-transform: none; letter-spacing: 0; margin-left: 6px; }
  .card {
    background: var(--card); border: 1px solid var(--line); border-radius: 12px;
    padding: 18px 20px; box-shadow: 0 1px 2px rgba(16,24,40,.04);
  }
  .wide { grid-column: 1 / -1; }
  .bench {
    grid-column: 1 / -1; display: flex; flex-wrap: wrap; align-items: center;
    gap: 18px 26px; background: var(--card); border: 1px solid var(--line);
    border-radius: 12px; padding: 14px 20px; box-shadow: 0 1px 2px rgba(16,24,40,.04);
  }
  .lights { display: flex; flex-wrap: wrap; gap: 8px 28px; flex: 1; min-width: 0; }
  .light { display: flex; align-items: center; gap: 10px; min-width: 150px; }
  .light b { display: block; font-weight: 600; font-size: 13px; }
  .light small { display: block; color: var(--muted); font-size: 12px; }
  .dot { width: 9px; height: 9px; border-radius: 50%; background: #c4c9d2; flex: none; }
  .light[data-state="up"] .dot,
  .light[data-state="running"] .dot { background: var(--ok); box-shadow: 0 0 0 4px rgba(22,163,74,.14); }
  .light[data-state="down"] .dot,
  .light[data-state="stopped"] .dot { background: var(--bad); box-shadow: 0 0 0 4px rgba(220,38,38,.12); }
  .light[data-state="connecting"] .dot,
  .light[data-state="unavailable"] .dot,
  .light[data-state="unconfigured"] .dot { background: var(--warn); box-shadow: 0 0 0 4px rgba(217,119,6,.12); }
  .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .row + .row { margin-top: 8px; }
  label { display: block; margin: 12px 0 6px; font-size: 12px; color: var(--muted); }
  label:first-of-type { margin-top: 0; }
  input, select, textarea {
    flex: 1; min-width: 0; background: #fff; color: var(--text);
    border: 1px solid #d0d5dd; border-radius: 8px; padding: 8px 11px; font: inherit;
    font-family: var(--mono); font-size: 13px;
  }
  textarea { resize: vertical; }
  select { flex: none; }
  input:focus, select:focus, textarea:focus { outline: none; border-color: var(--brand); box-shadow: 0 0 0 3px rgba(37,99,235,.14); }
  input[readonly] { background: #fafbfc; }
  button {
    background: var(--brand); color: #fff; border: 1px solid transparent; border-radius: 8px;
    padding: 8px 14px; font: inherit; cursor: pointer; white-space: nowrap;
  }
  button:hover { filter: brightness(1.05); }
  button:disabled { opacity: .55; cursor: default; }
  button.ghost { background: #fff; color: #344054; border-color: #d0d5dd; }
  button.danger { background: var(--bad); }
  button[data-armed="1"] { background: #b91c1c; border-color: #b91c1c; }
  a { color: var(--brand); }
  a[aria-disabled="true"] { color: var(--muted); pointer-events: none; text-decoration: none; }
  .hint { margin: 8px 0 0; color: var(--muted); font-size: 12px; }
  .alert { margin: 0; padding: 10px 14px; border-radius: 9px; font-size: 13px; grid-column: 1 / -1; }
  .alert[data-kind="error"] { background: #fef2f2; border: 1px solid #fecaca; color: #b91c1c; }
  .alert[data-kind="ok"] { background: #f0fdf4; border: 1px solid #bbf7d0; color: #15803d; }
  pre {
    margin: 0; height: 340px; overflow: auto; background: #fbfcfd; border: 1px solid var(--line);
    border-radius: 8px; padding: 10px 12px; font: 12px/1.65 var(--mono);
    white-space: pre-wrap; word-break: break-word; color: #344054;
  }
  pre .ts { color: #98a2b3; }
  pre .lv-error { color: #b91c1c; }
  pre .lv-warn { color: #b45309; }
  pre .lv-debug { color: #98a2b3; }
  .tools { list-style: none; margin: 0; padding: 0; display: grid; gap: 7px; }
  .tools li { display: flex; gap: 10px; align-items: baseline; font-size: 13px; }
  .tools b { font-family: var(--mono); font-size: 12px; color: var(--brand); min-width: 82px; }
  .tools span { color: var(--muted); }
  #tunnel-tail { height: 96px; margin-top: 10px; }
  @media (max-width: 900px) { main { grid-template-columns: 1fr; padding: 20px 16px 40px; } }
</style>
</head>
<body>
<main>
  <header>
    <h1>nexus-mcp</h1>
    <span class="tag" id="app-version">v${VERSION}</span>
    <span class="tag">本地控制面板 · 停 MCP 服务不影响这块页面</span>
  </header>

  <p class="alert" id="alert" hidden></p>

  <section class="bench" data-block="status">
    <div class="lights">
      <div class="light" id="light-executor" data-state="unavailable">
        <span class="dot"></span><div><b>执行器</b><small>读取中…</small></div>
      </div>
      <div class="light" id="light-service" data-state="down">
        <span class="dot"></span><div><b>MCP 服务</b><small>读取中…</small></div>
      </div>
      <div class="light" id="light-tunnel" data-state="unconfigured">
        <span class="dot"></span><div><b>隧道</b><small>读取中…</small></div>
      </div>
    </div>
    <div class="row" data-block="controls">
      <button id="stop" class="danger">停止服务</button>
      <button id="restart">重启服务</button>
      <button id="start">启动服务</button>
      <button id="reload" class="ghost">重载配置</button>
    </div>
  </section>

  <section class="card" data-block="address">
    <h2>连接信息</h2>
    <label>云端要填的 MCP 地址</label>
    <div class="row">
      <input id="mcp-url" readonly value="读取中…" />
      <button id="copy-all">复制地址+令牌</button>
    </div>
    <label>令牌</label>
    <div class="row">
      <input id="mcp-token" type="password" readonly value="读取中…" />
      <button id="toggle-token" class="ghost">显示</button>
      <button id="copy-token" class="ghost">复制</button>
    </div>
    <p class="hint" id="mcp-hint">—</p>
    <label>OAuth 授权</label>
    <a id="oauth-link" aria-disabled="true">OAuth 授权入口</a>
    <p class="hint" id="oauth-hint">—</p>
  </section>

  <section class="card" data-block="tunnel">
    <h2>隧道 <small id="tunnel-host">cloudflared</small></h2>
    <div class="row">
      <input id="tunnel-url" readonly value="未配置" />
      <button id="tunnel-probe" class="ghost">检测可达性</button>
    </div>
    <div class="row">
      <button id="tunnel-start">启动隧道</button>
      <button id="tunnel-stop" class="ghost danger">停止隧道</button>
    </div>
    <p class="hint" id="tunnel-hint">—</p>
    <p class="hint" id="tunnel-probe-result" hidden></p>
    <pre id="tunnel-tail" hidden></pre>
  </section>

  <section class="card" data-block="root">
    <h2>根目录</h2>
    <div class="row">
      <input id="root-path" value="" />
      <button id="pick-root" class="ghost">选择…</button>
      <button id="save-root">保存</button>
    </div>
    <p class="hint" id="root-hint">改完立即生效，同时写回 config.json</p>
  </section>

  <section class="card" data-block="settings">
    <h2>快捷设置 <small>保存即生效，同时写回 config.json</small></h2>
    <label>shell（bash 与 job_* 用的 shell）</label>
    <div class="row">
      <select id="set-shell">
        <option value="auto">auto（自动找 Git Bash）</option>
        <option value="git-bash">git-bash</option>
        <option value="pwsh">pwsh（PowerShell 7）</option>
      </select>
    </div>
    <label>单工具输出上限 maxOutputBytes（字节）</label>
    <div class="row"><input id="set-max-output" type="number" min="1" step="1" /></div>
    <label>单条命令默认超时 defaultTimeoutMs（毫秒）</label>
    <div class="row"><input id="set-timeout" type="number" min="1" step="1" /></div>
    <label>日志等级 logLevel（免重启即时生效）</label>
    <div class="row">
      <select id="set-log-level">
        <option value="debug">debug（排障详情，含 tool.start / ipc.done）</option>
        <option value="info">info（默认，工具摘要与管控事件）</option>
        <option value="warn">warn（仅告警与错误）</option>
        <option value="error">error（仅严重错误）</option>
      </select>
    </div>
    <label>隧道公网地址 tunnelUrl（留空清除）</label>
    <div class="row"><input id="set-tunnel-url" placeholder="https://nexus.example.com/" /></div>
    <label>命令白名单（一行一条通配模式，留空关闭白名单）</label>
    <div class="row"><textarea id="set-allow" rows="3" placeholder="git *&#10;npm run *&#10;cargo *"></textarea></div>
    <label>命令黑名单（一行一条，命中即拒）</label>
    <div class="row"><textarea id="set-deny" rows="3" placeholder="git push --force*"></textarea></div>
    <label>白名单未命中时</label>
    <div class="row">
      <select id="set-on-unmatched">
        <option value="deny">deny（默认，拒绝）</option>
        <option value="allow">allow（放行）</option>
      </select>
    </div>
    <div class="row" style="margin-top: 12px;">
      <button id="save-settings">保存快捷设置</button>
    </div>
    <p class="hint">命令闸门对下一次 bash / job_start 调用立即生效。panelPort、transport、token 不在这里改：
      直接改 config.json 后点「重载配置」。</p>
  </section>

  <section class="card" data-block="tools">
    <h2>可用工具 <small>${TOOL_SUMMARY.length} 个</small></h2>
    <ul class="tools">
      ${TOOL_ITEMS}
    </ul>
  </section>

  <section class="card wide" data-block="logs">
    <h2>最近日志 <small>最近 100 行，令牌已抹掉</small></h2>
    <div class="row">
      <input id="log-filter" placeholder="筛关键字，比如 debug / warn / sid= / read" />
      <button id="log-new" class="ghost" hidden>有新日志</button>
    </div>
    <pre id="logs">读取中…</pre>
  </section>
</main>
<script>
  var logBox = document.getElementById("logs");
  var rootInput = document.getElementById("root-path");
  var alertBox = document.getElementById("alert");
  var newLogButton = document.getElementById("log-new");
  var tokenInput = document.getElementById("mcp-token");
  var lastLines = [];
  var lastLogText = "";
  var filterText = "";
  var lastTunnelOkAt = null;
  var alertTimer = null;
  var refreshing = false;
  var logging = false;
  var currentToken = "";

  function showAlert(message, kind) {
    alertBox.textContent = message;
    alertBox.dataset.kind = kind || "error";
    alertBox.hidden = false;
    if (alertTimer) clearTimeout(alertTimer);
    alertTimer = setTimeout(function () { alertBox.hidden = true; }, 8000);
  }

  function pad(n) { return n < 10 ? "0" + n : String(n); }

  function clockText(date) {
    return pad(date.getHours()) + ":" + pad(date.getMinutes()) + ":" + pad(date.getSeconds());
  }

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
    setLight("light-service", s.service);
    setLight("light-tunnel", s.tunnel);

    document.getElementById("mcp-hint").textContent =
      s.service.label + " · 本地 http://127.0.0.1:" + s.service.port + "/mcp · 会话 " +
      s.service.sessions + " 个 · 面板端口 " + s.panelPort;

    var tunnelUrlInput = document.getElementById("tunnel-url");
    if (document.activeElement !== tunnelUrlInput) tunnelUrlInput.value = s.tunnel.url || "未配置";

    var tunnelHost = "cloudflared";
    if (s.tunnel.url) {
      try {
        tunnelHost = "cloudflared · " + new URL(s.tunnel.url).host;
      } catch (error) {
        tunnelHost = "cloudflared · " + s.tunnel.url;
      }
    }
    document.getElementById("tunnel-host").textContent = tunnelHost;

    if (s.tunnel.state === "up") lastTunnelOkAt = new Date();

    var tunnelParts = [s.tunnel.label];
    if (s.tunnel.detail) tunnelParts.push(s.tunnel.detail);
    var tunnelProc = s.tunnel.process || {};
    if (tunnelProc.pid) tunnelParts.push("pid " + tunnelProc.pid);
    if (tunnelProc.exitCode !== undefined && tunnelProc.exitCode !== null) {
      tunnelParts.push("退出码 " + tunnelProc.exitCode);
    }
    if (s.tunnel.state !== "up" && lastTunnelOkAt) {
      tunnelParts.push("上次正常 " + clockText(lastTunnelOkAt));
    }
    document.getElementById("tunnel-hint").textContent = tunnelParts.join(" · ");

    var tailBox = document.getElementById("tunnel-tail");
    var tailLines = s.tunnel.process && s.tunnel.process.tail ? s.tunnel.process.tail : [];
    tailBox.hidden = tailLines.length === 0;
    tailBox.textContent = tailLines.join("\\n");

    if (document.activeElement !== rootInput) rootInput.value = s.root;
  }

  function hasLogSelection() {
    var selection = window.getSelection();
    if (!selection || selection.toString().length === 0) return false;
    var node = selection.anchorNode;
    return !!node && logBox.contains(node);
  }

  function renderLogs(lines) {
    var shown = filterText
      ? lines.filter(function (line) { return line.toLowerCase().indexOf(filterText) >= 0; })
      : lines;
    if (shown.length === 0) {
      logBox.textContent = filterText ? "（没有匹配合键字的日志）" : "（还没有日志）";
      return;
    }
    var fragment = document.createDocumentFragment();
    shown.forEach(function (line) {
      var row = document.createElement("div");
      var match = /^(\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d+Z)\\s+([\\s\\S]*)$/.exec(line);
      var stamp = match ? match[1] : "";
      var text = match ? match[2] : line;
      if (stamp) {
        var time = new Date(stamp);
        var span = document.createElement("span");
        span.className = "ts";
        span.textContent = (isNaN(time.getTime()) ? stamp : clockText(time)) + "  ";
        row.appendChild(span);
      }
      var message = document.createElement("span");
      message.textContent = text;
      if (text.indexOf("[ERROR]") === 0) message.className = "lv-error";
      else if (text.indexOf("[WARN]") === 0) message.className = "lv-warn";
      else if (text.indexOf("[DEBUG]") === 0) message.className = "lv-debug";
      else if (text.indexOf("[INFO]") !== 0) {
        if (/error|failed|失败|出错|异常/i.test(text)) message.className = "lv-error";
        else if (/warn|警告|重试/i.test(text)) message.className = "lv-warn";
      }
      row.appendChild(message);
      fragment.appendChild(row);
    });
    // 上翻看旧日志时，重排不该把视口顶回顶部
    var keepScroll = logBox.scrollTop;
    logBox.textContent = "";
    logBox.appendChild(fragment);
    logBox.scrollTop = keepScroll;
  }

  async function refresh() {
    if (refreshing) return;
    refreshing = true;
    try {
      var res = await fetch("/api/status", { cache: "no-store" });
      if (res.ok) applyStatus(await res.json());
    } catch (error) {
      /* 面板自己还在，忽略这一轮 */
    } finally {
      refreshing = false;
    }
  }

  async function refreshLogs() {
    if (logging) return;
    logging = true;
    try {
      var res = await fetch("/api/logs", { cache: "no-store" });
      if (!res.ok) return;
      var body = await res.json();
      var lines = body.lines || [];
      var text = lines.join("\\n");
      var atBottom = logBox.scrollTop + logBox.clientHeight >= logBox.scrollHeight - 24;
      if (text === lastLogText) return;
      if (hasLogSelection()) return;
      lastLines = lines;
      lastLogText = text;
      renderLogs(lines);
      if (atBottom) {
        logBox.scrollTop = logBox.scrollHeight;
        newLogButton.hidden = true;
      } else {
        newLogButton.hidden = false;
      }
    } catch (error) {
      /* 同上 */
    } finally {
      logging = false;
    }
  }

  async function loadCredentials() {
    try {
      var res = await fetch("/api/credentials", { cache: "no-store" });
      if (!res.ok) return;
      var data = await res.json();
      currentToken = data.token || "";
      document.getElementById("mcp-url").value = data.publicUrl || data.url;
      tokenInput.value = currentToken || "（token 为空，仅限本机调试）";
      var link = document.getElementById("oauth-link");
      if (data.oauth && data.oauth.available) {
        link.setAttribute("href", data.oauth.url);
        link.removeAttribute("aria-disabled");
        document.getElementById("oauth-hint").textContent =
          "已启用 · 客户端跳转后要输入上面的令牌才能批准";
      } else {
        link.removeAttribute("href");
        link.setAttribute("aria-disabled", "true");
        document.getElementById("oauth-hint").textContent =
          "未启用（config.json 的 token 为空），云端直接用 Bearer 令牌";
      }
    } catch (error) {
      /* 读不到就保持读取中 */
    }
  }

  function fillSettings(s) {
    document.getElementById("set-shell").value = s.shell;
    document.getElementById("set-max-output").value = String(s.maxOutputBytes);
    document.getElementById("set-timeout").value = String(s.defaultTimeoutMs);
    document.getElementById("set-log-level").value = s.logLevel || "info";
    document.getElementById("set-tunnel-url").value = s.tunnelUrl || "";
    document.getElementById("set-allow").value = (s.commandPolicy.allow || []).join("\\n");
    document.getElementById("set-deny").value = (s.commandPolicy.deny || []).join("\\n");
    document.getElementById("set-on-unmatched").value = s.commandPolicy.onUnmatched;
  }

  async function loadSettings() {
    try {
      var res = await fetch("/api/settings", { cache: "no-store" });
      if (res.ok) fillSettings(await res.json());
    } catch (error) {
      /* 读不到先保持空值，下一轮再取 */
    }
  }

  async function post(pathname, body) {
    var res;
    try {
      res = await fetch(pathname, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
    } catch (error) {
      showAlert("请求没发出去：" + error.message);
      return null;
    }
    var data = null;
    try { data = await res.json(); } catch (error) { data = null; }
    if (!res.ok) {
      showAlert((data && data.error) || ("请求失败：HTTP " + res.status));
      return null;
    }
    if (data && data.service) applyStatus(data);
    return data;
  }

  async function copyText(text, button, label) {
    try {
      await navigator.clipboard.writeText(text);
    } catch (error) {
      var helper = document.createElement("textarea");
      helper.value = text;
      document.body.appendChild(helper);
      helper.select();
      document.execCommand("copy");
      document.body.removeChild(helper);
    }
    button.textContent = "已复制";
    setTimeout(function () { button.textContent = label; }, 1200);
  }

  function armConfirm(button, label, run) {
    if (button.dataset.armed === "1") {
      button.dataset.armed = "";
      button.textContent = label;
      run();
      return;
    }
    button.dataset.armed = "1";
    button.textContent = "再点一次确认";
    setTimeout(function () {
      if (button.dataset.armed === "1") {
        button.dataset.armed = "";
        button.textContent = label;
      }
    }, 4000);
  }

  document.getElementById("copy-all").addEventListener("click", function () {
    var url = document.getElementById("mcp-url").value;
    var text = currentToken ? "地址：" + url + "\\n令牌：" + currentToken : "地址：" + url;
    copyText(text, this, "复制地址+令牌");
  });

  document.getElementById("copy-token").addEventListener("click", function () {
    copyText(currentToken, this, "复制");
  });

  document.getElementById("toggle-token").addEventListener("click", function () {
    var hidden = tokenInput.type === "password";
    tokenInput.type = hidden ? "text" : "password";
    this.textContent = hidden ? "隐藏" : "显示";
  });

  document.getElementById("save-root").addEventListener("click", async function () {
    var data = await post("/api/root", { root: rootInput.value });
    if (data) showAlert("根目录已保存，工具立即生效", "ok");
  });

  document.getElementById("pick-root").addEventListener("click", async function () {
    var button = this;
    button.disabled = true;
    button.textContent = "选择中…";
    var data = await post("/api/browse", { path: rootInput.value });
    button.disabled = false;
    button.textContent = "选择…";
    if (data && data.path) {
      rootInput.value = data.path;
      showAlert("路径已选好，点保存才生效", "ok");
    }
  });

  document.getElementById("save-settings").addEventListener("click", async function () {
    var button = this;
    button.disabled = true;
    var lines = function (id) {
      return document.getElementById(id).value.split("\\n")
        .map(function (line) { return line.trim(); })
        .filter(function (line) { return line !== ""; });
    };
    var data = await post("/api/settings", {
      shell: document.getElementById("set-shell").value,
      maxOutputBytes: Number(document.getElementById("set-max-output").value),
      defaultTimeoutMs: Number(document.getElementById("set-timeout").value),
      logLevel: document.getElementById("set-log-level").value,
      tunnelUrl: document.getElementById("set-tunnel-url").value.trim(),
      commandPolicy: {
        allow: lines("set-allow"),
        deny: lines("set-deny"),
        onUnmatched: document.getElementById("set-on-unmatched").value
      }
    });
    button.disabled = false;
    if (data) {
      fillSettings(data.settings);
      showAlert("快捷设置已保存，写回 config.json", "ok");
    }
  });

  document.getElementById("stop").addEventListener("click", function () {
    armConfirm(this, "停止服务", function () { post("/api/service", { action: "stop" }); });
  });

  document.getElementById("restart").addEventListener("click", function () {
    armConfirm(this, "重启服务", function () { post("/api/service", { action: "restart" }); });
  });

  document.getElementById("start").addEventListener("click", function () {
    post("/api/service", { action: "start" });
  });

  document.getElementById("reload").addEventListener("click", function () {
    post("/api/service", { action: "reload" });
  });

  document.getElementById("tunnel-start").addEventListener("click", function () {
    post("/api/tunnel", { action: "start" });
  });

  document.getElementById("tunnel-stop").addEventListener("click", function () {
    armConfirm(this, "停止隧道", function () { post("/api/tunnel", { action: "stop" }); });
  });

  document.getElementById("tunnel-probe").addEventListener("click", async function () {
    var button = this;
    button.disabled = true;
    button.textContent = "检测中…";
    var data = await post("/api/tunnel", { action: "probe" });
    button.disabled = false;
    button.textContent = "检测可达性";
    if (!data || !data.probe) return;
    var probe = data.probe;
    var box = document.getElementById("tunnel-probe-result");
    box.hidden = false;
    if (probe.ok) {
      box.dataset.kind = "ok";
      box.textContent = "公网可达：HTTP " + probe.status + "，" + probe.ms + " 毫秒往返";
    } else {
      box.dataset.kind = "error";
      box.textContent = "公网不通：" + (probe.error || "未知原因") + "（" + probe.ms + " 毫秒）";
    }
  });

  document.getElementById("log-filter").addEventListener("input", function () {
    filterText = this.value.trim().toLowerCase();
    renderLogs(lastLines);
  });

  newLogButton.addEventListener("click", function () {
    logBox.scrollTop = logBox.scrollHeight;
    newLogButton.hidden = true;
  });

  document.addEventListener("visibilitychange", function () {
    if (!document.hidden) {
      refresh();
      refreshLogs();
    }
  });

  loadCredentials();
  loadSettings();
  refresh();
  refreshLogs();
  setInterval(function () {
    if (document.hidden) return;
    refresh();
    refreshLogs();
  }, 5000);
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
 * 写操作的公共壳：跨站防护 + JSON 解析，被拒或坏请求时已写完响应并返回 undefined。
 * 返回 true 表示请求体可用。
 */
async function readWriteBody(
  req: IncomingMessage,
  res: ServerResponse,
  panelPort: number,
): Promise<Record<string, unknown> | undefined> {
  if (blockUnsafeWrite(req, res, panelPort)) return undefined;
  try {
    return await readJson(req);
  } catch (error) {
    sendJson(res, 400, { error: (error as Error).message });
    return undefined;
  }
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

/** 跑一段 PowerShell：优先 pwsh 7（AGENTS.md 的要求），机器上没有就退回自带的 5.1 */
function runPowerShell(script: string): Promise<string> {
  const args = ["-NoProfile", "-STA", "-WindowStyle", "Hidden", "-Command", script];
  const attempt = (exe: string): Promise<string> =>
    new Promise((resolve, reject) => {
      execFile(exe, args, { windowsHide: true, timeout: 180_000 }, (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(stdout.trim());
      });
    });
  return attempt("pwsh.exe").catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
    return attempt("powershell.exe");
  });
}

/**
 * 弹系统文件夹选择框（Windows）。用户取消时返回空串。
 * 面板在浏览器里，浏览器给不了本地绝对路径，只能借系统对话框。
 *
 * 必须把对话框绑到当前前台窗口当 owner：隐藏进程弹的「孤儿」对话框 z-order 会落到
 * 浏览器后面，用户得先把浏览器缩下去才看得见（2026-11-22 实测反馈）。
 */
async function pickFolder(initial: string): Promise<string> {
  // 单引号字符串里 PowerShell 不展开变量，只要把 ' 变成 ''
  const escaped = initial.replace(/'/g, "''");
  const script = [
    "[Console]::OutputEncoding = [Text.Encoding]::UTF8",
    "Add-Type -AssemblyName System.Windows.Forms",
    "Add-Type -TypeDefinition @'",
    "using System;",
    "using System.Runtime.InteropServices;",
    "using System.Windows.Forms;",
    "public static class NexusWin32 {",
    '  [DllImport("user32.dll")]',
    "  public static extern IntPtr GetForegroundWindow();",
    "}",
    "public class NexusOwner : IWin32Window {",
    "  private readonly IntPtr handle;",
    "  public NexusOwner(IntPtr h) { handle = h; }",
    "  public IntPtr Handle { get { return handle; } }",
    "}",
    "'@ -ReferencedAssemblies System.Windows.Forms",
    "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog",
    '$dialog.Description = "选择 nexus-mcp 的沙箱根目录"',
    `$dialog.SelectedPath = '${escaped}'`,
    "$dialog.ShowNewFolderButton = $true",
    "$owner = [NexusWin32]::GetForegroundWindow()",
    "if ($owner -ne [IntPtr]::Zero) {",
    "  $result = $dialog.ShowDialog([NexusOwner]::new($owner))",
    "} else {",
    "  $result = $dialog.ShowDialog()",
    "}",
    "if ($result -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $dialog.SelectedPath }",
  ].join("\n");
  return runPowerShell(script);
}

export async function startPanel(
  config: AppConfig,
  service: McpService,
  tunnel?: TunnelManager,
): Promise<PanelHandle> {
  let panelPort = config.panelPort;
  let currentTunnel: TunnelManager | undefined = tunnel;

  async function syncTunnelManager(nextConfig: AppConfig): Promise<void> {
    const options = resolveTunnelOptions(nextConfig);
    if (!options) {
      if (currentTunnel) {
        await currentTunnel.stopManaged();
        currentTunnel = undefined;
      }
      return;
    }
    if (currentTunnel) {
      await currentTunnel.syncOptions(options);
    } else {
      currentTunnel = new TunnelManager(options);
    }
  }

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
      executor: await executorStatus(),
      tunnel: await tunnelStatus(config, currentTunnel),
      root: config.root,
      panelPort,
      version: VERSION,
    };
  }

  /** 面板要显示的敏感信息与公网地址；单独一个接口，避免 token 混进每 5 秒的状态轮询 */
  function credentialsPayload(): {
    url: string;
    publicUrl: string;
    token: string;
    oauth: { url: string; available: boolean };
  } {
    const publicUrl = config.tunnelUrl
      ? `${config.tunnelUrl.replace(/\/+$/, "")}/mcp`
      : "";
    return {
      url: service.url(),
      publicUrl,
      token: config.token,
      oauth: service.oauthInfo(),
    };
  }

  /** 快捷设置卡当前值；只暴露面板能安全修改的字段，token/端口类刻意不含 */
  function settingsPayload() {
    return {
      shell: config.shell,
      maxOutputBytes: config.maxOutputBytes,
      defaultTimeoutMs: config.defaultTimeoutMs,
      logLevel: config.logLevel,
      tunnelUrl: config.tunnelUrl ?? "",
      commandPolicy: config.commandPolicy,
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

    if (req.method === "GET" && url.pathname === "/api/credentials") {
      sendJson(res, 200, credentialsPayload());
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/logs") {
      const token = config.token;
      sendJson(res, 200, { lines: recentLogs().map((line) => redactText(line, token)) });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/browse") {
      const body = await readWriteBody(req, res, panelPort);
      if (!body) return;
      const start =
        typeof body.path === "string" && path.isAbsolute(body.path.trim()) ? body.path.trim() : config.root;
      try {
        const picked = await pickFolder(start);
        sendJson(res, 200, { path: picked });
      } catch (error) {
        sendJson(res, 500, { error: `打开目录选择框失败：${(error as Error).message}` });
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/root") {
      const body = await readWriteBody(req, res, panelPort);
      if (!body) return;
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
      logInfo("panel.root", { root: abs });
      sendJson(res, 200, await statusPayload());
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/settings") {
      sendJson(res, 200, settingsPayload());
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/settings") {
      const body = await readWriteBody(req, res, panelPort);
      if (!body) return;

      const patch: {
        shell?: AppConfig["shell"];
        maxOutputBytes?: number;
        defaultTimeoutMs?: number;
        logLevel?: AppConfig["logLevel"];
        tunnelUrl?: string;
        commandPolicy?: AppConfig["commandPolicy"];
      } = {};
      try {
        // 校验规则与 loadConfig 完全同源：写进 config.json 的值必须能通过下次启动校验
        if (body.shell !== undefined) {
          validateShell(body.shell);
          patch.shell = body.shell;
        }
        if (body.maxOutputBytes !== undefined) {
          patch.maxOutputBytes = normalizePositiveInt(body.maxOutputBytes, "maxOutputBytes");
        }
        if (body.defaultTimeoutMs !== undefined) {
          patch.defaultTimeoutMs = normalizePositiveInt(body.defaultTimeoutMs, "defaultTimeoutMs");
        }
        if (body.logLevel !== undefined) {
          patch.logLevel = normalizeLogLevel(body.logLevel);
        }
        if (body.tunnelUrl !== undefined) {
          patch.tunnelUrl = normalizeTunnelUrl(body.tunnelUrl) ?? "";
        }
        if (body.commandPolicy !== undefined) {
          patch.commandPolicy = normalizeCommandPolicy(body.commandPolicy);
        }
      } catch (error) {
        sendJson(res, 400, { error: (error as Error).message });
        return;
      }

      // 工具调用每次都现读这个共享对象，改完即生效，不需要重启
      if (patch.shell !== undefined) config.shell = patch.shell;
      if (patch.maxOutputBytes !== undefined) config.maxOutputBytes = patch.maxOutputBytes;
      if (patch.defaultTimeoutMs !== undefined) config.defaultTimeoutMs = patch.defaultTimeoutMs;
      if (patch.logLevel !== undefined) {
        config.logLevel = patch.logLevel;
        setLogLevel(patch.logLevel);
      }
      if (patch.tunnelUrl !== undefined) {
        if (patch.tunnelUrl) config.tunnelUrl = patch.tunnelUrl;
        else delete config.tunnelUrl;
      }
      if (patch.commandPolicy !== undefined) config.commandPolicy = patch.commandPolicy;

      saveConfig(config);
      logInfo("panel.settings", { shell: config.shell, logLevel: config.logLevel });
      sendJson(res, 200, { ...(await statusPayload()), settings: settingsPayload() });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/service") {
      const body = await readWriteBody(req, res, panelPort);
      if (!body) return;
      const action = typeof body.action === "string" ? body.action : "";

      try {
        if (action === "stop") {
          await service.stop();
          logInfo("panel.service", { action: "stop" });
        } else if (action === "start") {
          await service.start();
          logInfo("panel.service", { action: "start" });
        } else if (action === "restart") {
          // 只断开重连，不重读磁盘配置；要带上配置文件改动就用「重载配置」
          await service.stop();
          await service.start();
          logInfo("panel.service", { action: "restart" });
        } else if (action === "reload") {
          const next = loadConfig();
          replaceConfigInPlace(config, next);
          setLogLevel(config.logLevel);
          await syncTunnelManager(config);
          logInfo("panel.service", { action: "reload", root: config.root, logLevel: config.logLevel });
          if (next.panelPort !== panelPort) {
            logWarn("panel.reload_port_pending", { panelPort: next.panelPort });
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
        logError("panel.service_error", { action, err: (error as Error).message });
        sendJson(res, 500, { error: `操作失败: ${(error as Error).message}` });
        return;
      }

      sendJson(res, 200, await statusPayload());
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/tunnel") {
      if (!currentTunnel) {
        sendJson(res, 400, { error: "未启用隧道管理（config.json 里没有 tunnel 段）" });
        return;
      }
      const body = await readWriteBody(req, res, panelPort);
      if (!body) return;
      const action = typeof body.action === "string" ? body.action : "";

      try {
        if (action === "start") {
          const result = await currentTunnel.start();
          logInfo("panel.tunnel", {
            action: "start",
            started: result.started,
            pid: result.pid,
            reason: result.reason,
          });
        } else if (action === "stop") {
          await currentTunnel.stop();
          logInfo("panel.tunnel", { action: "stop" });
        } else if (action === "probe") {
          // 手动探测：真的往外打一次，把状态码和往返耗时报给面板。
          // 状态灯已经不靠它了（见 status.ts 的 tunnelStatus），这里只是链路体检。
          const probe = await probePublicTunnel(config);
          if (probe.ok) {
            logInfo("tunnel.probe", { ok: true, status: probe.status, ms: probe.ms });
          } else {
            logWarn("tunnel.probe", { ok: false, ms: probe.ms, err: probe.error });
          }
          sendJson(res, 200, { probe });
          return;
        } else {
          sendJson(res, 400, { error: `未知操作: ${action}` });
          return;
        }
      } catch (error) {
        logError("panel.tunnel_error", { action, err: (error as Error).message });
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
      logError("panel.error", { err: safeMessage });
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
  logInfo("panel.ready", { url: `http://${LISTEN_HOST}:${panelPort}` });

  return {
    port: panelPort,
    url: `http://${LISTEN_HOST}:${panelPort}`,
    async close() {
      currentTunnel?.cancelPendingRestart();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
}
