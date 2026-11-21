import type { AppConfig } from "./config.js";
import { probeExecutorHandshake } from "./executor.js";

export type ComponentState = "up" | "down" | "unavailable" | "unconfigured";

export interface ComponentStatus {
  state: ComponentState;
  label: string;
  detail?: string;
}

/** 执行器状态：真握手——临时起一个执行器进程发 ping，回得来才算在线，不做假绿灯 */
export async function executorStatus(): Promise<ComponentStatus> {
  const probe = await probeExecutorHandshake();
  return probe.ok
    ? { state: "up", label: "在线", detail: "ping 往返正常" }
    : { state: "down", label: "异常", detail: probe.detail };
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

  try {
    // 面板每 5 秒轮询一次，探测超时必须短于间隔，否则请求会排队
    const response = await fetch(config.tunnelUrl, {
      signal: AbortSignal.timeout(2000),
      redirect: "manual",
    });
    await response.body?.cancel();
    // 401/404 也说明隧道和后面的服务是活的
    return response.status < 500
      ? { state: "up", label: "在线", detail: `HTTP ${response.status}` }
      : { state: "down", label: "异常", detail: `HTTP ${response.status}` };
  } catch (error) {
    return { state: "down", label: "离线", detail: (error as Error).message };
  }
}
