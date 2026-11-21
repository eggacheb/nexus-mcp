import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { registerTools } from "./tools.js";

const config = loadConfig();

const server = new McpServer(
  { name: "nexus-mcp", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

registerTools(server, config);

const useStdio = process.argv.includes("--stdio") || config.transport === "stdio";

if (!useStdio) {
  console.error(
    "HTTP 传输尚未接入，当前只能以 stdio 启动。加 --stdio 参数，或在 config.json 里设 transport=stdio。",
  );
  process.exit(1);
}

const transport = new StdioServerTransport();
await server.connect(transport);

// stdio 模式下 stdout 属于协议通道，日志一律走 stderr
console.error(`[nexus-mcp] stdio 已就绪，根目录: ${config.root}`);
