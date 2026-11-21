import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let client: Client;

beforeAll(async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(projectRoot, "dist", "index.js"), "--stdio"],
    cwd: projectRoot,
    stderr: "ignore",
  });
  client = new Client({ name: "vitest", version: "0.1.0" });
  await client.connect(transport);
});

afterAll(async () => {
  await client.close();
});

describe("工具清单", () => {
  it("暴露全部 8 个工具", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "bash",
      "edit",
      "glob",
      "grep",
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
    expect(result.isError).toBeFalsy();
  });
});
