import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { projectRoot } from "./support/server.js";

interface ToolResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

function textOf(result: ToolResult): string {
  return result.content[0]?.text ?? "";
}

interface StdioSession {
  client: Client;
  close(): Promise<void>;
}

async function connectStdio(env: Record<string, string> = {}): Promise<StdioSession> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(projectRoot, "dist", "index.js"), "--stdio"],
    cwd: projectRoot,
    env: { ...process.env, ...env } as Record<string, string>,
    stderr: "ignore",
  });
  const client = new Client({ name: "vitest-edit", version: "0.1.0" });
  await client.connect(transport);
  return {
    client,
    async close() {
      await client.close();
    },
  };
}

async function callEdit(client: Client, args: Record<string, unknown>): Promise<ToolResult> {
  return (await client.callTool({ name: "edit", arguments: args })) as ToolResult;
}

describe("edit 工具", () => {
  let session: StdioSession;
  let root: string;
  let configDir: string;

  beforeAll(async () => {
    root = mkdtempSync(path.join(os.tmpdir(), "nexus-edit-root-"));
    configDir = mkdtempSync(path.join(os.tmpdir(), "nexus-edit-cfg-"));
    const configPath = path.join(configDir, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({ root, transport: "stdio", shell: "auto" }, null, 2),
      "utf8",
    );
    session = await connectStdio({ NEXUS_MCP_CONFIG: configPath });
  }, 30_000);

  afterAll(async () => {
    await session?.close();
    for (const dir of [root, configDir]) {
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  const write = (name: string, content: string): void =>
    writeFileSync(path.join(root, name), content, "utf8");
  const readRaw = (name: string): string => readFileSync(path.join(root, name), "utf8");
  const readBytes = (name: string): Buffer => readFileSync(path.join(root, name));

  it(
    "old_string 唯一出现时替换成功，并返回改动位置",
    { timeout: 15_000 },
    async () => {
      write("unique.txt", "alpha\nbeta\ngamma\n");
      const result = await callEdit(session.client, {
        path: "unique.txt",
        old_string: "beta",
        new_string: "BETA",
      });
      expect(result.isError).toBeFalsy();
      expect(textOf(result)).toContain("第 2 行");
      expect(readRaw("unique.txt")).toBe("alpha\nBETA\ngamma\n");
    },
  );

  it(
    "跨行块替换成功，位置覆盖整个块",
    { timeout: 15_000 },
    async () => {
      write("block.txt", "fn a() {\n    body();\n}\nfn b() {\n}\n");
      const result = await callEdit(session.client, {
        path: "block.txt",
        old_string: "fn a() {\n    body();\n}",
        new_string: "fn a() {\n    body(1);\n}",
      });
      expect(result.isError).toBeFalsy();
      expect(textOf(result)).toContain("第 1-3 行");
      expect(readRaw("block.txt")).toBe("fn a() {\n    body(1);\n}\nfn b() {\n}\n");
    },
  );

  it(
    "多处匹配且未指定 replace_all 时失败并报「匹配到 N 处」，文件不动",
    { timeout: 15_000 },
    async () => {
      write("multi.txt", "x\nx\nx\n");
      const result = await callEdit(session.client, {
        path: "multi.txt",
        old_string: "x",
        new_string: "y",
      });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("匹配到 3 处");
      expect(readRaw("multi.txt")).toBe("x\nx\nx\n");
    },
  );

  it(
    "完全不存在时失败，并提示可能是缩进或空白差异（带 missHint 行号）",
    { timeout: 15_000 },
    async () => {
      write("hint.txt", "fn main() {\n    let x = compute(1);\n}\n");
      const result = await callEdit(session.client, {
        path: "hint.txt",
        old_string: "fn main() {\n  let x = compute(1);\n}",
        new_string: "fn main() {\n  let x = compute(2);\n}",
      });
      expect(result.isError).toBe(true);
      const text = textOf(result);
      expect(text).toContain("找不到");
      expect(text).toContain("缩进");
      // missHint 按忽略空白的行投票定位最近区域，行号与 read 一致
      expect(text).toContain("1: fn main() {");
      expect(readRaw("hint.txt")).toBe("fn main() {\n    let x = compute(1);\n}\n");
    },
  );

  it(
    "new_string 已在文件中时提示编辑可能已应用",
    { timeout: 15_000 },
    async () => {
      write("applied.txt", "const value = 42; // 已经改过了\n");
      const result = await callEdit(session.client, {
        path: "applied.txt",
        old_string: "const value = 41; // 已经改过了",
        new_string: "const value = 42; // 已经改过了",
      });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("已经应用");
    },
  );

  it(
    "replace_all 替换全部匹配，并返回替换数量",
    { timeout: 15_000 },
    async () => {
      write("all.txt", "x\nx\nx\n");
      const result = await callEdit(session.client, {
        path: "all.txt",
        old_string: "x",
        new_string: "y",
        replace_all: true,
      });
      expect(result.isError).toBeFalsy();
      expect(textOf(result)).toContain("替换 3 处");
      expect(readRaw("all.txt")).toBe("y\ny\ny\n");
    },
  );

  it(
    "行尾空白有轻微差异时仍能定位（第三级模糊匹配）",
    { timeout: 15_000 },
    async () => {
      write("fuzzy.txt", "let a = 1;   \nlet b = 2;\t\n");
      const result = await callEdit(session.client, {
        path: "fuzzy.txt",
        old_string: "let a = 1;\nlet b = 2;",
        new_string: "let a = 10;\nlet b = 20;",
      });
      expect(result.isError).toBeFalsy();
      expect(readRaw("fuzzy.txt")).toBe("let a = 10;\nlet b = 20;\n");
    },
  );

  it(
    "行级模糊匹配要求缩进一致：多行块缩进不同时按找不到处理（与 opencode 一致）",
    { timeout: 15_000 },
    async () => {
      write("indent.txt", "fn a() {\n        body();\n}\n");
      const result = await callEdit(session.client, {
        path: "indent.txt",
        old_string: "fn a() {\n    body();\n}",
        new_string: "fn a() {\n    body(1);\n}",
      });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("找不到");
      expect(readRaw("indent.txt")).toBe("fn a() {\n        body();\n}\n");
    },
  );

  it(
    "CRLF 文件替换后仍是 CRLF，不被改写成 LF",
    { timeout: 15_000 },
    async () => {
      write("crlf.txt", "第一行\r\nsecond\r\nthird\r\n");
      const result = await callEdit(session.client, {
        path: "crlf.txt",
        old_string: "second",
        new_string: "2nd",
      });
      expect(result.isError).toBeFalsy();
      expect(readBytes("crlf.txt")).toEqual(Buffer.from("第一行\r\n2nd\r\nthird\r\n", "utf8"));
    },
  );

  it(
    "混合行尾文件替换后各行保持自己的行尾",
    { timeout: 15_000 },
    async () => {
      write("mixed.txt", "one\r\ntwo\nthree\r\n");
      const first = await callEdit(session.client, {
        path: "mixed.txt",
        old_string: "two",
        new_string: "TWO",
      });
      expect(first.isError).toBeFalsy();
      expect(readBytes("mixed.txt")).toEqual(Buffer.from("one\r\nTWO\nthree\r\n", "utf8"));

      // 跨行替换：保留的行逐字节沿用原行尾，新插入的行继承区域行尾
      const second = await callEdit(session.client, {
        path: "mixed.txt",
        old_string: "one\r\nTWO",
        new_string: "one\r\nTWO\r\n1.5",
      });
      expect(second.isError).toBeFalsy();
      expect(readBytes("mixed.txt")).toEqual(
        Buffer.from("one\r\nTWO\r\n1.5\nthree\r\n", "utf8"),
      );
    },
  );

  it(
    "替换后文件仍是合法 UTF-8，中文不产生乱码",
    { timeout: 15_000 },
    async () => {
      write("utf8.txt", "标题：旧标题\n正文：第一段\n");
      const result = await callEdit(session.client, {
        path: "utf8.txt",
        old_string: "旧标题",
        new_string: "新标题",
      });
      expect(result.isError).toBeFalsy();
      const raw = readBytes("utf8.txt");
      expect(raw.equals(Buffer.from("标题：新标题\n正文：第一段\n", "utf8"))).toBe(true);
      expect(raw.toString("utf8")).not.toContain("\uFFFD");
    },
  );

  it(
    "空 old_string 被拒绝，文件不被清空",
    { timeout: 15_000 },
    async () => {
      write("empty.txt", "keep me\n");
      const result = await callEdit(session.client, {
        path: "empty.txt",
        old_string: "",
        new_string: "x",
      });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("old_string");
      expect(readRaw("empty.txt")).toBe("keep me\n");
    },
  );
});
