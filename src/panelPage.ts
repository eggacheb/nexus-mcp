import { ICON_DATA_URI_SVG } from "./icon.js";
import { TOOL_SUMMARY } from "./tools.js";
import { VERSION } from "./version.js";

const TOOL_ITEMS = TOOL_SUMMARY.map(
  (tool) => `<li><b>${tool.name}</b><span>${tool.summary}</span></li>`,
).join("\n      ");

export const PANEL_PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<link rel="icon" type="image/svg+xml" href="${ICON_DATA_URI_SVG}" />
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
    <span class="tag" id="hotswap-tag" hidden></span>
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
    <h2>隧道 <small id="tunnel-host">单通道互斥</small></h2>
    <label>公网接入渠道（同一时刻仅启用一种）</label>
    <div class="row">
      <select id="tunnel-mode">
        <option value="none">关闭（仅本机）</option>
        <option value="quick">临时隧道（零账号，重启换域名）</option>
        <option value="tailscale">Tailscale Funnel（免买域名固定地址）</option>
        <option value="named">Cloudflare 命名隧道（自有固定域名）</option>
      </select>
      <button id="tunnel-apply">切换渠道</button>
    </div>
    <div class="row">
      <input id="tunnel-url" readonly value="未配置" />
      <button id="tunnel-probe" class="ghost">检测可达性</button>
    </div>
    <div class="row">
      <button id="tunnel-start">启动隧道</button>
      <button id="tunnel-stop" class="ghost danger">停止隧道</button>
    </div>
    <p class="hint" id="tunnel-ephemeral-note" hidden>临时域名在进程重启后会变更；长期使用建议切换为 Tailscale Funnel 或 Cloudflare 命名隧道。</p>
    <p class="hint" id="tunnel-ts-guide" hidden>
      <a id="tunnel-ts-link" href="https://tailscale.com/download" target="_blank" rel="noopener">前往 Tailscale 后台 / 下载</a>
    </p>
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

    var verTag = document.getElementById("app-version");
    if (verTag && s.version) {
      verTag.textContent = s.buildId ? "v" + s.version + " · " + s.buildId : "v" + s.version;
    }
    var hsTag = document.getElementById("hotswap-tag");
    if (hsTag) {
      if (s.lastHotswap && s.lastHotswap.status) {
        hsTag.textContent = "上次热切换: " + s.lastHotswap.status + " (" + (s.lastHotswap.mode || "-") + ")";
        hsTag.hidden = false;
      } else {
        hsTag.hidden = true;
      }
    }

    document.getElementById("mcp-hint").textContent =
      s.service.label + " · 本地 http://127.0.0.1:" + s.service.port + "/mcp · 会话 " +
      s.service.sessions + " 个 · 面板端口 " + s.panelPort;

    var tunnelModeSelect = document.getElementById("tunnel-mode");
    if (tunnelModeSelect && document.activeElement !== tunnelModeSelect && s.tunnel.mode) {
      tunnelModeSelect.value = s.tunnel.mode;
    }
    var ephemeralNote = document.getElementById("tunnel-ephemeral-note");
    if (ephemeralNote) ephemeralNote.hidden = !s.tunnel.ephemeral;
    var tsGuide = document.getElementById("tunnel-ts-guide");
    var tsLink = document.getElementById("tunnel-ts-link");
    if (tsGuide && tsLink) {
      var ts = s.tunnel.tailscale;
      if (s.tunnel.mode === "tailscale" && ts && ts.approvalUrl) {
        tsLink.href = ts.approvalUrl;
        tsLink.textContent = "去 Tailscale 后台点一下启用 Funnel（完成后再点「启动隧道」）";
        tsGuide.hidden = false;
      } else if (s.tunnel.mode === "tailscale" && ts && !ts.installed) {
        tsLink.href = "https://tailscale.com/download";
        tsLink.textContent = "未检测到 Tailscale：点击前往官网下载并登录，再点「启动隧道」";
        tsGuide.hidden = false;
      } else {
        tsGuide.hidden = true;
      }
    }

    var tunnelUrlInput = document.getElementById("tunnel-url");
    if (document.activeElement !== tunnelUrlInput) tunnelUrlInput.value = s.tunnel.url || "未配置";

    var tunnelHost = s.tunnel.mode === "quick" ? "临时隧道" : s.tunnel.mode === "tailscale" ? "Tailscale Funnel" : "cloudflared";
    if (s.tunnel.url) {
      try {
        tunnelHost = tunnelHost + " · " + new URL(s.tunnel.url).host;
      } catch (error) {
        tunnelHost = tunnelHost + " · " + s.tunnel.url;
      }
    }
    document.getElementById("tunnel-host").textContent = tunnelHost;

    if (s.tunnel.state === "up") lastTunnelOkAt = new Date();

    var tunnelParts = [s.tunnel.label];
    if (s.tunnel.detail) tunnelParts.push(s.tunnel.detail);
    var tunnelProc = s.tunnel.process || {};
    if (s.tunnel.mode === "quick" && s.tunnel.quick && s.tunnel.quick.pid) {
      tunnelParts.push("pid " + s.tunnel.quick.pid);
    } else if (tunnelProc.pid) {
      tunnelParts.push("pid " + tunnelProc.pid);
    }
    if (tunnelProc.exitCode !== undefined && tunnelProc.exitCode !== null) {
      tunnelParts.push("退出码 " + tunnelProc.exitCode);
    }
    if (s.tunnel.state !== "up" && lastTunnelOkAt) {
      tunnelParts.push("上次正常 " + clockText(lastTunnelOkAt));
    }
    document.getElementById("tunnel-hint").textContent = tunnelParts.join(" · ");

    var tailBox = document.getElementById("tunnel-tail");
    var tailLines =
      s.tunnel.mode === "quick" && s.tunnel.quick && s.tunnel.quick.tail
        ? s.tunnel.quick.tail
        : s.tunnel.process && s.tunnel.process.tail
          ? s.tunnel.process.tail
          : [];
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
      logBox.textContent = filterText ? "（没有匹配关键字的日志）" : "（还没有日志）";
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

  document.getElementById("tunnel-apply").addEventListener("click", async function () {
    var button = this;
    var mode = document.getElementById("tunnel-mode").value;
    button.disabled = true;
    button.textContent = "切换中…";
    var data = await post("/api/tunnel", { action: "mode", mode: mode });
    button.disabled = false;
    button.textContent = "切换渠道";
    if (data) {
      loadCredentials();
      showAlert("隧道渠道已切换为 " + mode, "ok");
    }
  });

  document.getElementById("tunnel-start").addEventListener("click", async function () {
    var data = await post("/api/tunnel", { action: "start" });
    if (data) loadCredentials();
  });

  document.getElementById("tunnel-stop").addEventListener("click", function () {
    armConfirm(this, "停止隧道", async function () {
      var data = await post("/api/tunnel", { action: "stop" });
      if (data) loadCredentials();
    });
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
