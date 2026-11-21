import type { AppConfig } from "./config.js";
import { probeExecutorHandshake } from "./executor.js";
import type { TunnelManager, TunnelProcessInfo } from "./tunnel.js";

export type ComponentState = "up" | "down" | "unavailable" | "unconfigured";

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

interface ProbeResult {
  /** 只有 HTTP 200 算可达：404 说明 ingress 指错地方，502 说明隧道后的服务挂了 */
  ok: boolean;
  status?: number;
  error?: string;
}

/** 公网可达性探测：打隧道公网地址下的指定路径，默认 /health（与排障文档一致） */
async function probeEndpoint(publicUrl: string, pathname = "/health"): Promise<ProbeResult> {
  try {
    // 面板每 5 秒轮询一次，探测超时必须短于间隔，否则请求会排队
    const response = await fetch(`${publicUrl.replace(/\/+$/, "")}${pathname}`, {
      signal: AbortSignal.timeout(2000),
      redirect: "manual",
    });
    await response.body?.cancel();
    return response.status === 200
      ? { ok: true, status: response.status }
      : { ok: false, status: response.status, error: `HTTP ${response.status}` };
  } catch (error) {
    // vmThreads 池里 fetch 的异常来自主 realm，跨 realm 不能 instanceof，取 cause 的 message 用鸭子判断
    const cause = (error as { cause?: { message?: unknown } }).cause;
    const message =
      cause && typeof cause === "object" && typeof cause.message === "string"
        ? cause.message
        : String((error as Error).message ?? error);
    return { ok: false, error: message };
  }
}

/** 隧道状态：配置了 tunnelUrl 才去探，探测失败不抛错，只标记离线 */
export async function probeTunnel(config: AppConfig): Promise<ComponentStatus> {
  if (!config.tunnelUrl) {
    return {
      state: "unconfigured",
      label: "未配置",
      detail: "在 config.json 里填 tunnelUrl 后这里显示真实连通性",
    };
  }

  const probe = await probeEndpoint(config.tunnelUrl);
  if (probe.ok) return { state: "up", label: "在线", detail: `HTTP ${probe.status}` };
  if (probe.status !== undefined) return { state: "down", label: "异常", detail: probe.error ?? "" };
  return { state: "down", label: "离线", detail: probe.error ?? "" };
}

/**
 * 隧道状态合成：进程在不在（红/绿第一层）+ 公网通不通（第二层）。
 * 未启用隧道管理时退回纯公网探测（旧行为，兼容只配 tunnelUrl 的部署）。
 */
export async function tunnelStatus(config: AppConfig, tunnel?: TunnelManager): Promise<TunnelStatus> {
  const url = config.tunnelUrl?.trim() || undefined;
  const base = url ? { url } : {};

  if (!tunnel) {
    if (!url) {
      return {
        state: "unconfigured",
        label: "未配置",
        detail: "在 config.json 里填 tunnelUrl 后这里显示真实连通性",
      };
    }
    return { ...base, ...(await probeTunnel(config)) };
  }

  const proc = await tunnel.status();
  const withProcess = { ...base, process: proc };
  if (proc.exeMissing) {
    return { ...withProcess, state: "unavailable", label: "不可用", detail: `找不到 cloudflared：${proc.cloudflaredPath}` };
  }
  if (proc.configMissing) {
    return { ...withProcess, state: "unavailable", label: "不可用", detail: `找不到隧道配置：${proc.configPath}` };
  }
  if (!proc.running) {
    const parts = ["未运行"];
    if (proc.exitCode !== undefined) parts.push(`退出码 ${proc.exitCode}`);
    if (proc.autoRestarting) parts.push("稍后自动重启");
    return { ...withProcess, state: "down", label: "离线", detail: parts.join("，") };
  }
  if (!url) {
    return { ...withProcess, state: "up", label: "运行中", detail: "进程在跑（未配 tunnelUrl，无法探测公网）" };
  }
  const probe = await probeEndpoint(url);
  if (probe.ok) {
    return { ...withProcess, state: "up", label: "在线", detail: `公网可达（HTTP ${probe.status}）` };
  }
  return { ...withProcess, state: "down", label: "异常", detail: `进程在跑但公网不通：${probe.error}` };
}
