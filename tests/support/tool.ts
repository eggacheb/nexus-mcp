import { expect } from "vitest";

/** MCP 工具返回的最小形状；content/text 可选（SDK 的 content 可能是图片等非文本项，任务型返回甚至没有 content） */
export interface ToolResult {
  content?: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

export function textOf(result: ToolResult): string {
  return result.content?.[0]?.text ?? "";
}

/** 期望工具成功的断言：失败时把工具返回的文本带进消息，省一次复现。
 * 参数收 unknown：SDK 的 callTool 返回是联合（任务型分支连 isError 都没有），TS 弱类型检测会拒绝
 * 任何全可选的目标接口；类型安全在函数内部用最小断言承担。 */
export function expectOk(result: unknown): void {
  const isError = (result as ToolResult | undefined)?.isError;
  expect(isError, textOf(result as ToolResult)).toBeFalsy();
}
