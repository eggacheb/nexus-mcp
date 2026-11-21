import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 自带隔离配置：不读仓库根的 config.json（部署配置的 root 不一定是项目根）
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const configDir = mkdtempSync(path.join(os.tmpdir(), "nexus-mcp-smoke-"));
const configPath = path.join(configDir, "config.json");
writeFileSync(
  configPath,
  JSON.stringify({ root: projectRoot, transport: "stdio" }, null, 2),
  "utf8",
);

try {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["dist/index.js", "--stdio"],
    env: { ...process.env, NEXUS_MCP_CONFIG: configPath } as Record<string, string>,
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
} finally {
  rmSync(configDir, { recursive: true, force: true });
}
