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
  arguments: { path: "package.json", limit: 5 },
});
console.log("\nread 调用结果:");
console.log(JSON.stringify(probe, null, 2));
if (probe.isError) {
  console.error("read 自检失败：工具返回 isError");
  await client.close();
  process.exit(1);
}

await client.close();
