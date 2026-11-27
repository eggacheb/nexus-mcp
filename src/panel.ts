import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import type { AppConfig, TunnelMode } from "./config.js";
import {
  effectiveTunnelMode,
  loadConfig,
  normalizeCommandPolicy,
  normalizeLogLevel,
  normalizePositiveInt,
  normalizeTunnelMode,
  normalizeTunnelUrl,
  replaceConfigInPlace,
  saveConfig,
  validateShell,
} from "./config.js";
import { readBody, sendJson as sendJsonRaw } from "./httpHelpers.js";
import type { LogLevel } from "./log.js";
import {
  logError,
  logInfo,
  logWarn,
  parseLogLevel,
  queryLogs,
  redactText,
  resolveLogDir,
  setLogLevel,
} from "./log.js";
import type { McpService } from "./mcpService.js";
import { QuickTunnelManager } from "./quickTunnel.js";
import type { TailscaleInfo } from "./tailscale.js";
import { detectTailscale, disableTailscaleFunnel, enableTailscaleFunnel } from "./tailscale.js";
import type { ComponentStatus, LastHotswapInfo, TunnelStatus } from "./status.js";
import {
  executorStatus,
  getRuntimeIdentity,
  probePublicTunnel,
  readLastHotswap,
  tunnelStatus,
} from "./status.js";
import { PANEL_PAGE } from "./panelPage.js";
import { TunnelManager, resolveTunnelOptions } from "./tunnel.js";

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
  /** 当前运行入口程序的短 SHA-256 指纹 */
  buildId: string;
  /** 协议层启动时间（ISO-8601） */
  startedAt: string;
  /** 协议层进程 PID */
  pid: number;
  /** 最近一次热切换的结构化结果（来自日志目录 last-hotswap.json） */
  lastHotswap: LastHotswapInfo | null;
}

export interface PanelHandle {
  port: number;
  url: string;
  close(): Promise<void>;
}

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
  onShutdown?: (options: { includeTunnel: boolean }) => Promise<void> | void,
): Promise<PanelHandle> {
  let panelPort = config.panelPort;
  let currentTunnel: TunnelManager | undefined = tunnel;
  const quickTunnel = new QuickTunnelManager();
  let lastTailscale: TailscaleInfo | undefined;
  let lastTailscaleAt = 0;

  function activePublicUrl(): string {
    const mode = effectiveTunnelMode(config);
    if (mode === "quick") return quickTunnel.currentUrl() ?? "";
    if (mode === "tailscale") return lastTailscale?.url ?? config.tailscaleUrl?.trim() ?? "";
    return config.tunnelUrl?.trim() ?? "";
  }

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
    const mode = effectiveTunnelMode(config);
    if (mode === "tailscale" && !lastTailscale?.approvalUrl && Date.now() - lastTailscaleAt > 3_000) {
      lastTailscale = await detectTailscale(service.port());
      lastTailscaleAt = Date.now();
    }
    const identity = getRuntimeIdentity();
    return {
      service: {
        state: running ? "running" : "stopped",
        label: running ? "运行中" : "已停止",
        port: service.port(),
        url: service.url(),
        sessions: service.sessionCount(),
      },
      executor: await executorStatus(),
      tunnel: await tunnelStatus(config, currentTunnel, quickTunnel, mode === "tailscale" ? lastTailscale : undefined),
      root: config.root,
      panelPort,
      version: identity.version,
      buildId: identity.buildId,
      startedAt: identity.startedAt,
      pid: identity.pid,
      lastHotswap: readLastHotswap(resolveLogDir(), config.token),
    };
  }

  /** 面板要显示的敏感信息与公网地址；单独一个接口，避免 token 混进每 5 秒的状态轮询 */
  function credentialsPayload(): {
    url: string;
    publicUrl: string;
    token: string;
    tunnelMode: TunnelMode;
    ephemeral: boolean;
    oauth: { url: string; available: boolean };
  } {
    const mode = effectiveTunnelMode(config);
    const activeUrl = activePublicUrl();
    const publicUrl = activeUrl ? `${activeUrl.replace(/\/+$/, "")}/mcp` : "";
    return {
      url: service.url(),
      publicUrl,
      token: config.token,
      tunnelMode: mode,
      ephemeral: mode === "quick",
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
      res.end(PANEL_PAGE);
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

    if (req.method === "GET" && url.pathname === "/api/hotswap") {
      sendJson(res, 200, { lastHotswap: readLastHotswap(resolveLogDir(), config.token) });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/logs") {
      const token = config.token;
      const levelRaw = url.searchParams.get("level")?.trim();
      let level: LogLevel | undefined;
      if (levelRaw) {
        const parsed = parseLogLevel(levelRaw);
        if (!parsed) {
          sendJson(res, 400, { error: `不支持的 level 参数：${levelRaw}` });
          return;
        }
        level = parsed;
      }
      const limitRaw = url.searchParams.get("limit")?.trim();
      let limit: number | undefined;
      if (limitRaw) {
        const parsed = Number(limitRaw);
        if (!Number.isInteger(parsed) || parsed < 1) {
          sendJson(res, 400, { error: `limit 必须是正整数，收到：${limitRaw}` });
          return;
        }
        limit = parsed;
      }
      const q = url.searchParams.get("q") ?? undefined;
      sendJson(res, 200, {
        lines: queryLogs({ level, limit, q }).map((line) => redactText(line, token)),
      });
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
      const body = await readWriteBody(req, res, panelPort);
      if (!body) return;
      const action = typeof body.action === "string" ? body.action : "";
      const activeMode = effectiveTunnelMode(config);

      try {
        if (action === "mode") {
          let nextMode: TunnelMode | undefined;
          try {
            nextMode = normalizeTunnelMode(body.mode);
          } catch (error) {
            sendJson(res, 400, { error: (error as Error).message });
            return;
          }
          if (!nextMode) {
            sendJson(res, 400, { error: "缺少合法的 mode 参数（none / quick / tailscale / named）" });
            return;
          }
          if (nextMode === "named" && !currentTunnel) {
            sendJson(res, 400, { error: "未启用命名隧道（config.json 里没有 tunnel 段）" });
            return;
          }
          // 单通道互斥：切往新渠道前先停旧渠道
          if (activeMode !== nextMode) {
            if (quickTunnel.isRunning()) await quickTunnel.stop();
            if (activeMode === "named" && currentTunnel) await currentTunnel.stop();
            if (activeMode === "tailscale") {
              await disableTailscaleFunnel();
              lastTailscale = undefined;
              lastTailscaleAt = 0;
            }
          }

          if (nextMode === "quick") {
            await quickTunnel.start(service.port(), config);
          } else if (nextMode === "tailscale") {
            const ts = await enableTailscaleFunnel(service.port());
            lastTailscale = ts;
            lastTailscaleAt = Date.now();
            if (ts.funnelActive && ts.url) {
              config.tailscaleUrl = ts.url;
            }
          } else if (nextMode === "named" && currentTunnel) {
            await currentTunnel.start();
          }

          config.tunnelMode = nextMode;
          saveConfig(config);
          logInfo("panel.tunnel", { action: "mode", from: activeMode, to: nextMode });
        } else if (action === "detect-tailscale") {
          lastTailscale = await detectTailscale(service.port());
          lastTailscaleAt = Date.now();
          sendJson(res, 200, { tailscale: lastTailscale, status: await statusPayload() });
          return;
        } else if (action === "start") {
          if (activeMode === "quick") {
            await quickTunnel.start(service.port(), config);
            logInfo("panel.tunnel", { action: "start", mode: "quick" });
          } else if (activeMode === "tailscale") {
            const ts = await enableTailscaleFunnel(service.port());
            lastTailscale = ts;
            lastTailscaleAt = Date.now();
            if (ts.funnelActive && ts.url) {
              config.tailscaleUrl = ts.url;
              saveConfig(config);
            }
            logInfo("panel.tunnel", { action: "start", mode: "tailscale", active: ts.funnelActive });
          } else if (activeMode === "named") {
            if (!currentTunnel) {
              sendJson(res, 400, { error: "未启用隧道管理（config.json 里没有 tunnel 段）" });
              return;
            }
            const result = await currentTunnel.start();
            logInfo("panel.tunnel", {
              action: "start",
              started: result.started,
              pid: result.pid,
              reason: result.reason,
            });
          } else {
            sendJson(res, 400, { error: "当前未启用隧道管理（请先选择一种隧道渠道）" });
            return;
          }
        } else if (action === "stop") {
          if (activeMode === "quick") {
            await quickTunnel.stop();
            logInfo("panel.tunnel", { action: "stop", mode: "quick" });
          } else if (activeMode === "tailscale") {
            await disableTailscaleFunnel();
            lastTailscale = await detectTailscale(service.port());
            lastTailscaleAt = Date.now();
            logInfo("panel.tunnel", { action: "stop", mode: "tailscale" });
          } else if (activeMode === "named") {
            if (!currentTunnel) {
              sendJson(res, 400, { error: "未启用隧道管理（config.json 里没有 tunnel 段）" });
              return;
            }
            await currentTunnel.stop();
            logInfo("panel.tunnel", { action: "stop" });
          } else {
            sendJson(res, 400, { error: "当前未启用隧道管理（config.json 里没有 tunnel 段）" });
            return;
          }
        } else if (action === "probe") {
          // 手动探测：真的往外打一次，把状态码和往返耗时报给面板。
          // 状态灯已经不靠它了（见 status.ts 的 tunnelStatus），这里只是链路体检。
          const probe = await probePublicTunnel(config, activePublicUrl() || undefined);
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

    if (req.method === "POST" && url.pathname === "/api/shutdown") {
      const body = await readWriteBody(req, res, panelPort);
      if (!body) return;
      if (body.includeTunnel !== undefined && typeof body.includeTunnel !== "boolean") {
        sendJson(res, 400, { error: "includeTunnel 必须是布尔值" });
        return;
      }
      const includeTunnel = body.includeTunnel !== false;
      logInfo("panel.shutdown", { includeTunnel });
      sendJson(res, 200, { ok: true, includeTunnel });
      setImmediate(() => {
        void (async () => {
          if (includeTunnel) {
            await quickTunnel.stop().catch((error: unknown) => {
              logWarn("panel.shutdown_quick_tunnel_error", { err: (error as Error).message });
            });
            if (currentTunnel) {
              await currentTunnel.stop().catch((error: unknown) => {
                logWarn("panel.shutdown_tunnel_error", { err: (error as Error).message });
              });
            }
          } else if (currentTunnel) {
            currentTunnel.cancelPendingRestart();
          }
          await onShutdown?.({ includeTunnel });
        })();
      });
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
      await quickTunnel.stop().catch(() => undefined);
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
}
