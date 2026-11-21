import type { AppConfig } from "./config.js";

export type ComponentState = "up" | "down" | "unavailable" | "unconfigured";

export interface ComponentStatus {
  state: ComponentState;
  label: string;
  detail?: string;
}

/**
 * 执行器状态。Rust 执行层还没落地，这里如实报「未接入」，
 * 不做假绿灯。03 票接入后换成真的握手探测。
 */
export function executorStatus(): ComponentStatus {
  return {
    state: "unavailable",
    label: "未接入",
    detail: "Rust 执行器尚未落地，读写与命令仍返回 stub",
  };
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
