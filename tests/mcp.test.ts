import { expectOk } from "./support/tool.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ExecutorClient } from "../src/executor.js";
import type { JobKillResponse, JobOutputResponse, JobStartResponse } from "../src/executor.js";

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

  it("纯只读工具携带标准 MCP readOnlyHint 注解，变更与执行类工具不标记为只读", async () => {
    const { tools } = await client.listTools();
    const readOnlyNames = new Set(["read", "glob", "grep", "job_output"]);
    for (const tool of tools) {
      if (readOnlyNames.has(tool.name)) {
        expect(tool.annotations?.readOnlyHint).toBe(true);
        expect(tool.annotations?.destructiveHint).toBe(false);
      } else {
        expect(tool.annotations?.readOnlyHint).not.toBe(true);
      }
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

describe("执行层多路并发与按文件写锁", () => {
  it(
    "慢 bash 执行期间并发 read 不被队头阻塞",
    { timeout: 20_000 },
    async () => {
      const slowStarted = Date.now();
      let readFinishedAt = 0;
      let bashFinishedAt = 0;

      const bashPromise = client
        .callTool({
          name: "bash",
          arguments: { command: "sleep 1.5; echo slow-ok" },
        })
        .then((res) => {
          bashFinishedAt = Date.now();
          return res;
        });

      // 略等 150ms 确保 bash 已发出到执行层，再并发发 read
      await new Promise((r) => setTimeout(r, 150));
      const readRes = await client.callTool({
        name: "read",
        arguments: { path: "package.json", offset: 1, limit: 5 },
      });
      readFinishedAt = Date.now();
      expectOk(readRes);

      const bashRes = await bashPromise;
      expectOk(bashRes);
      // read 必须显著早于慢 bash 完成（证明未被串行堵死）
      expect(readFinishedAt - slowStarted).toBeLessThan(1200);
      expect(bashFinishedAt).toBeGreaterThan(readFinishedAt);
    },
  );

  it(
    "同一文件并发 edit 自动串行不丢改动",
    { timeout: 20_000 },
    async () => {
      const rel = `.scratch/.tmp-concurrent-edit-${Date.now()}.txt`;
      const abs = path.join(projectRoot, rel);
      try {
        const lines = Array.from({ length: 6 }, (_, i) => `item-${i}=old`).join("\n") + "\n";
        const w = await client.callTool({ name: "write", arguments: { path: rel, content: lines } });
        expectOk(w);

        const results = await Promise.all(
          Array.from({ length: 6 }, (_, i) =>
            client.callTool({
              name: "edit",
              arguments: {
                path: rel,
                old_string: `item-${i}=old`,
                new_string: `item-${i}=new`,
              },
            }),
          ),
        );
        for (const r of results) expectOk(r);

        const content = readFileSync(abs, "utf8");
        for (let i = 0; i < 6; i += 1) {
          expect(content).toContain(`item-${i}=new`);
        }
      } finally {
        rmSync(abs, { force: true });
      }
    },
  );

  it(
    "单请求超时仅 reject 当前请求，不误杀同执行器内的后台任务",
    { timeout: 20_000 },
    async () => {
      const exec = new ExecutorClient();
      const bashProgram =
        process.env.NEXUS_GIT_BASH || String.raw`C:\Program Files\Git\bin\bash.exe`;
      try {
        const started = await exec.request<JobStartResponse>({
          op: "job_start",
          command: "sleep 10",
          root: projectRoot,
          cwd: projectRoot,
          max_output_bytes: 4096,
          shell: { kind: "git-bash", program: bashProgram },
        });
        expect(started.ok).toBe(true);
        if (!started.ok) return;

        // 故意给一个短 IPC deadline，让这条慢 bash 在客户端超时 reject
        let errMessage = "";
        try {
          await exec.request(
            {
              op: "bash",
              command: "sleep 1.2",
              root: projectRoot,
              cwd: projectRoot,
              timeout_ms: 5000,
              max_output_bytes: 4096,
              shell: { kind: "git-bash", program: bashProgram },
            },
            { deadlineMs: 250 },
          );
        } catch (err) {
          errMessage = (err as Error).message;
        }
        expect(errMessage).toContain("没有响应请求");

        // 执行器仍存活且先前启动的后台任务未被误杀
        const out = await exec.request<JobOutputResponse>({
          op: "job_output",
          job_id: started.job_id,
          offset: 0,
          max_output_bytes: 4096,
        });
        expect(out.ok).toBe(true);
        if (out.ok) expect(out.status).toBe("running");

        const killed = await exec.request<JobKillResponse>({
          op: "job_kill",
          job_id: started.job_id,
        });
        expect(killed.ok).toBe(true);
      } finally {
        await exec.close();
      }
    },
  );
});
