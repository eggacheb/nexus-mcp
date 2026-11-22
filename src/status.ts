import http from "node:http";
import type { AppConfig } from "./config.js";
import { probeExecutorHandshake } from "./executor.js";
import type { TunnelManager, TunnelProcessInfo } from "./tunnel.js";

/** connecting = 进程在跑但还没连上 Cloudflare 边缘（黄灯，不是故障） */
export type ComponentState = "up" | "down" | "connecting" | "unavailable" | "unconfigured";

export interface ComponentStatus {
  state: ComponentState;
  label: string;
  detail?: string;
}

/** 隧道状态：合成灯 + 公网地址 + 进程详情（pid、退出码、错误尾行） */
export interface TunnelStatus extends ComponentStatus {
  /** 公网地址（config.tunnelUrl） */
  url?: string;
  /** 隧道进程详情；未启用隧道管理（config.json 没有 tunnel 段）时没有这块 */
  process?: TunnelProcessInfo;
}

/** 执行器状态：真握手——临时起一个执行器进程发 ping，回得来才算在线，不做假绿灯 */
export async function executorStatus(): Promise<ComponentStatus> {
  const probe = await probeExecutorHandshake();
  return probe.ok
    ? { state: "up", label: "在线", detail: "ping 往返正常" }
    : { state: "down", label: "异常", detail: probe.detail };
}

export interface ProbeResult {
  /** 只有 HTTP 200 算可达：404 说明 ingress 指错地方，502 说明隧道后的服务挂了 */
  ok: boolean;
  status?: number;
  error?: string;
  /** 往返耗时：手动探测时展示链路快慢，也是「2 秒超时为什么不够」的证据 */
  ms?: number;
}

/**
 * 公网可达性探测：打隧道公网地址下的指定路径，默认 /health。
 * 只用于手动「检测可达性」——它绕经系统代理，往返实测能到 2-3 秒，
 * 拿来驱动状态灯就是抖动来源（见 docs/tunnel.md 注 2）。
 */
async function probeEndpoint(
  publicUrl: string,
  pathname = "/health",
  timeoutMs = 8000,
): Promise<ProbeResult> {
  const startedAt = Date.now();
  const elapsed = () => Date.now() - startedAt;
  try {
    const response = await fetch(`${publicUrl.replace(/\/+$/, "")}${pathname}`, {
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "manual",
    });
    await response.body?.cancel();
    return response.status === 200
      ? { ok: true, status: response.status, ms: elapsed() }
      : { ok: false, status: response.status, error: `HTTP ${response.status}`, ms: elapsed() };
  } catch (error) {
    // vmThreads 池里 fetch 的异常来自主 realm，跨 realm 不能 instanceof，取 cause 的 message 用鸭子判断
    const cause = (error as { cause?: { message?: unknown } }).cause;
    const message =
      cause && typeof cause === "object" && typeof cause.message === "string"
        ? cause.message
        : String((error as Error).message ?? error);
    return { ok: false, error: message, ms: elapsed() };
  }
}

/** cloudflared 默认就监听这个端口，不用改启动参数 */
export const DEFAULT_METRICS_PORT = 20241;

interface MetricsProbe {
  ok: boolean;
  readyConnections?: number;
  error?: string;
}

/**
 * 读 cloudflared 自己的 /ready：回环请求、毫秒级、不经过系统代理。
 * 这是隧道连通性的主信号——`readyConnections > 0` 表示边缘连接真的在。
 * 用 node:http 而不是 fetch，是为了绕开 NODE_USE_ENV_PROXY（本地不该走代理）。
 */
function probeMetrics(port: number): Promise<MetricsProbe> {
  return new Promise((resolve) => {
    const request = http.get(
      { host: "127.0.0.1", port, path: "/ready", timeout: 800 },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          if (body.length < 4096) body += chunk;
        });
        response.on("end", () => {
          if (response.statusCode !== 200) {
            resolve({ ok: false, error: `HTTP ${response.statusCode}` });
            return;
          }
          try {
            const parsed = JSON.parse(body) as { readyConnections?: unknown };
            const connections = typeof parsed.readyConnections === "number" ? parsed.readyConnections : 0;
            resolve({ ok: true, readyConnections: connections });
          } catch {
            resolve({ ok: false, error: "metrics 返回的不是 JSON" });
          }
        });
        response.on("error", (error: Error) => resolve({ ok: false, error: error.message }));
      },
    );
    request.on("timeout", () => request.destroy(new Error("探测超时")));
    request.on("error", (error: Error) => resolve({ ok: false, error: error.message }));
  });
}

/** 手动「检测可达性」：一次性公网探测。状态灯不走它，用户可以随时点一次看链路真实往返 */
export async function probePublicTunnel(config: AppConfig): Promise<ProbeResult> {
  if (!config.tunnelUrl?.trim()) return { ok: false, error: "config.json 里没有 tunnelUrl" };
  return probeEndpoint(config.tunnelUrl);
}

/**
 * 隧道状态：以 cloudflared 本地 metrics 的就绪连接为主信号。
 * 公网往返会被系统代理和链路抖动带偏（实测 0.9-3.5 秒波动），不再驱动状态灯。
 */
export async function tunnelStatus(config: AppConfig, tunnel?: TunnelManager): Promise<TunnelStatus> {
  const url = config.tunnelUrl?.trim() || undefined;
  const base = url ? { url } : {};

  if (!tunnel) {
    // 没有 tunnel 段就拿不到本地就绪连接，只能承认「验不了」。
    // 不退回公网往返：那条路绕代理、会抖，拿来点灯就是假红。
    return {
      ...base,
      state: "unconfigured",
      label: "未启用管理",
      detail: "config.json 加 tunnel 段，面板才能在这里验证隧道连通性",
    };
  }

  const proc = await tunnel.status();
  const withProcess = { ...base, process: proc };

  // 配置错误先说清楚：路径失效时即便端口上有服务，用户点「启动隧道」也一定会失败
  if (proc.exeMissing) {
    return { ...withProcess, state: "unavailable", label: "不可用", detail: `找不到 cloudflared：${proc.cloudflaredPath}` };
  }
  if (proc.configMissing) {
    return { ...withProcess, state: "unavailable", label: "不可用", detail: `找不到隧道配置：${proc.configPath}` };
  }

  const metricsPort = config.tunnel?.metricsPort ?? DEFAULT_METRICS_PORT;
  const metrics = await probeMetrics(metricsPort);

  if (metrics.ok) {
    const connections = metrics.readyConnections ?? 0;
    if (connections > 0) {
      return {
        ...withProcess,
        state: "up",
        label: "在线",
        detail: `${connections} 条就绪连接`,
      };
    }
    return {
      ...withProcess,
      state: "connecting",
      label: "连接中",
      detail: `cloudflared 在跑，还没连上 Cloudflare 边缘（metrics :${metricsPort}）`,
    };
  }

  if (!proc.running) {
    const parts = ["未运行"];
    if (proc.exitCode !== undefined) parts.push(`退出码 ${proc.exitCode}`);
    if (proc.autoRestarting) parts.push("稍后自动重启");
    return { ...withProcess, state: "down", label: "离线", detail: parts.join("，") };
  }
  // 进程在跑但 metrics 探不到：外部拉起没开 metrics，或端口被改过。
  // 探不到不等于不通，给黄灯「运行中」，别报红。
  return {
    ...withProcess,
    state: "connecting",
    label: "运行中",
    detail: `进程在跑（metrics :${metricsPort} 不通，未验证边缘连接）`,
  };
}
