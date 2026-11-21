import { spawn } from "node:child_process";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { log } from "./log.js";
import { createMcpService } from "./mcpService.js";
import { startPanel } from "./panel.js";
import { createServer } from "./server.js";
import { resolveTunnelManager } from "./tunnel.js";
import { VERSION } from "./version.js";

// 本机网络经 HTTP 代理出网（HTTPS_PROXY/ALL_PROXY），Node 24 的 fetch 默认不理会这些
// 环境变量——面板的公网可达性探测会直连 Cloudflare 而超时。打开 NODE_USE_ENV_PROXY 让
// fetch 跟随系统代理与 NO_PROXY（无代理环境的机器上这个开关是空操作）。
process.env.NODE_USE_ENV_PROXY = process.env.NODE_USE_ENV_PROXY ?? "1";

/** 打包版双击启动时替用户把面板拉起来；替用户开浏览器只在 Windows 上做 */
function openPanelInBrowser(url: string): void {
  if (process.platform !== "win32") return;
  try {
    spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore", windowsHide: true }).unref();
  } catch (error) {
    log(`没能自动打开浏览器（手动访问 ${url}）：${(error as Error).message}`);
  }
}

/**
 * 顶层 await 会挡住把整包打成 CJS 单文件（SEA 只吃 CJS），所以入口收进一个函数。
 */
async function main(): Promise<void> {
  const config = loadConfig();

  // --stdio 优先于配置，方便本机客户端与测试固定走 stdio
  const useStdio = process.argv.includes("--stdio") || config.transport === "stdio";

  if (useStdio) {
    const server = createServer(config);
    await server.connect(new StdioServerTransport());
    // stdio 模式下 stdout 属于协议通道，日志一律走 stderr
    console.error(`[nexus-mcp] v${VERSION} stdio 已就绪，根目录: ${config.root}`);
    return;
  }

  const service = createMcpService(config);
  await service.start();

  const tunnel = resolveTunnelManager(config);
  if (tunnel) log("隧道管理已启用（面板可启停 cloudflared）");
  const panel = await startPanel(config, service, tunnel);

  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    await panel.close();
    await service.stop();
    process.exit(0);
  };
  log(`nexus-mcp v${VERSION} 面板入口: ${panel.url}`);
  if (process.argv.includes("--open-panel")) openPanelInBrowser(panel.url);
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((error: unknown) => {
  console.error(`[nexus-mcp] 启动失败: ${(error as Error).message}`);
  process.exit(1);
});
