import { expectOk } from "./support/tool.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let client: Client;
let configDir: string;

beforeAll(async () => {
  // 自带隔离配置：不读仓库根的 config.json（那里是部署配置，root 不是 projectRoot）
  configDir = mkdtempSync(path.join(os.tmpdir(), "nexus-mcp-stdio-"));
  const configPath = path.join(configDir, "config.json");
  writeFileSync(
    configPath,
    JSON.stringify({ root: projectRoot, transport: "stdio" }, null, 2),
    "utf8",
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(projectRoot, "dist", "index.js"), "--stdio"],
    cwd: projectRoot,
    env: { ...process.env, NEXUS_MCP_CONFIG: configPath } as Record<string, string>,
    stderr: "ignore",
  });
  client = new Client({ name: "vitest", version: "0.1.0" });
  await client.connect(transport);
});

afterAll(async () => {
  await client.close();
  rmSync(configDir, { recursive: true, force: true });
});

describe("工具清单", () => {
  it("暴露全部 9 个工具", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "bash",
      "edit",
      "glob",
      "grep",
      "job_kill",
      "job_output",
      "job_start",
      "read",
      "write",
    ]);
  });

  it("每个工具都有非空描述", async () => {
    const { tools } = await client.listTools();
    for (const tool of tools) {
      expect(tool.description?.trim().length ?? 0).toBeGreaterThan(0);
    }
  });

  it("initialize 返回的 serverInfo 携带标准 icons", () => {
    const info = client.getServerVersion();
    expect(info?.name).toBe("nexus-mcp");
    const icons = info?.icons ?? [];
    expect(icons.length).toBeGreaterThanOrEqual(2);
    // src 必须是可公网抓取的 URL，不允许 data URI（Gemini 连接器会拒绝整个连接）
    expect(icons.some((i) => i.mimeType === "image/png" && i.src.endsWith("/icon.png") && !i.src.startsWith("data:"))).toBe(
      true,
    );
    expect(icons.some((i) => i.mimeType === "image/svg+xml" && i.src.endsWith("/favicon.svg") && !i.src.startsWith("data:"))).toBe(
      true,
    );
  });
});

describe("沙箱边界", () => {
  it("拒绝根目录之外的路径", async () => {
    const result = await client.callTool({
      name: "read",
      arguments: { path: "../../etc/passwd" },
    });
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? "";
    expect(text).toContain("路径越界");
  });

  it("接受根目录内的相对路径", async () => {
    const result = await client.callTool({
      name: "read",
      arguments: { path: "package.json" },
    });
    expectOk(result);
  });
});
