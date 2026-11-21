/** 进程内日志环形缓冲：stderr 照常输出，同时留一份给面板读 */
const CAPACITY = 200;

const lines: string[] = [];

export function log(message: string): void {
  lines.push(`${new Date().toISOString()} ${message}`);
  if (lines.length > CAPACITY) lines.splice(0, lines.length - CAPACITY);
  console.error(`[nexus-mcp] ${message}`);
}

/** 面板只取最近 100 行；调用方负责把令牌抹掉 */
export function recentLogs(count = 100): string[] {
  return lines.slice(-count);
}
