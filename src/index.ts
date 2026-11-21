import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { log } from "./log.js";
import { createMcpService } from "./mcpService.js";
import { startPanel } from "./panel.js";
import { createServer } from "./server.js";

const config = loadConfig();

// --stdio 优先于配置，方便本机客户端与测试固定走 stdio
const useStdio = process.argv.includes("--stdio") || config.transport === "stdio";

if (useStdio) {
  const server = createServer(config);
  await server.connect(new StdioServerTransport());
  // stdio 模式下 stdout 属于协议通道，日志一律走 stderr
  console.error(`[nexus-mcp] stdio 已就绪，根目录: ${config.root}`);
} else {
  const service = createMcpService(config);
  await service.start();

  const panel = await startPanel(config, service);

  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    await panel.close();
    await service.stop();
    process.exit(0);
  };
  log(`面板入口: ${panel.url}`);
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}
