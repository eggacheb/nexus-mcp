import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["dist/index.js", "--stdio"],
  stderr: "inherit",
});

const client = new Client({ name: "nexus-mcp-smoke", version: "0.1.0" });
await client.connect(transport);

const listed = await client.listTools();
console.log(`工具数量: ${listed.tools.length}`);
for (const tool of listed.tools) {
  console.log(`- ${tool.name}: ${tool.description ?? ""}`);
}

const probe = await client.callTool({
  name: "read",
  arguments: { path: "README.md", limit: 5 },
});
console.log("\nread 调用结果:");
console.log(JSON.stringify(probe, null, 2));

await client.close();
