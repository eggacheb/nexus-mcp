import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppConfig } from "./config.js";
import { registerTools } from "./tools.js";

/** 每个连接建一个实例，工具注册与配置在这里收敛，传输层只管挂载 */
export function createServer(config: AppConfig): McpServer {
  const server = new McpServer(
    { name: "nexus-mcp", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );
  registerTools(server, config);
  return server;
}
