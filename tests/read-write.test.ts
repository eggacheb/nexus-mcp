import { expectOk } from "./support/tool.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
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
  const client = new Client({ name: "vitest-rw", version: "0.1.0" });
  await client.connect(transport);
  return {
    client,
    async close() {
      await client.close();
    },
  };
}

async function callRead(client: Client, args: Record<string, unknown>): Promise<ToolResult> {
  return (await client.callTool({ name: "read", arguments: args })) as ToolResult;
}

async function callWrite(client: Client, args: Record<string, unknown>): Promise<ToolResult> {
  return (await client.callTool({ name: "write", arguments: args })) as ToolResult;
}

function makeFileSymlink(target: string, link: string): boolean {
  try {
    symlinkSync(target, link, "file");
    return true;
  } catch {
    return false;
  }
}

/**
 * 造一个「根内入口 → 根外目标」的逃逸链接。
 * 文件符号链接需要特权（EPERM 时退回目录 junction——免特权，且同样被
 * canonicalize 解析成根外真实路径），都造不出来返回 null。
 */
function makeEscapeLink(root: string, outside: string):
  | { readPath: string; writePath: string }
  | null {
  const fileLink = path.join(root, "leak.md");
  if (makeFileSymlink(path.join(outside, "target.txt"), fileLink)) {
    return { readPath: "leak.md", writePath: "leak.md" };
  }
  try {
    symlinkSync(outside, path.join(root, "leakdir"), "junction");
    return { readPath: "leakdir/target.txt", writePath: "leakdir/new.txt" };
  } catch {
    return null;
  }
}

describe("read/write 工具", () => {
  let session: StdioSession;
  let root: string;
  let outside: string;
  const configDirs: string[] = [];

  beforeAll(async () => {
    root = mkdtempSync(path.join(os.tmpdir(), "nexus-rw-root-"));
    outside = mkdtempSync(path.join(os.tmpdir(), "nexus-rw-out-"));
    const configDir = mkdtempSync(path.join(os.tmpdir(), "nexus-rw-cfg-"));
    const configPath = path.join(configDir, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({ root, transport: "stdio", shell: "auto" }, null, 2),
      "utf8",
    );
    session = await connectStdio({ NEXUS_MCP_CONFIG: configPath });
    // config 目录在 afterAll 一并清理
    configDirs.push(configDir);
  }, 30_000);

  afterAll(async () => {
    await session?.close();
    for (const dir of [root, outside, ...configDirs]) {
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  it(
    "read 返回带行号的内容，行号与文件真实行号一致",
    { timeout: 15_000 },
    async () => {
      const file = path.join(root, "numbered.txt");
      writeFileSync(file, "alpha\nbeta\ngamma\n", "utf8");
      const result = await callRead(session.client, { path: "numbered.txt" });
      expectOk(result);
      const text = textOf(result);
      expect(text).toMatch(/1\talpha/);
      expect(text).toMatch(/2\tbeta/);
      expect(text).toMatch(/3\tgamma/);
    },
  );

  it(
    "offset 与 limit 按行切分，行号保持真实编号",
    { timeout: 15_000 },
    async () => {
      const file = path.join(root, "sliced.txt");
      const lines = Array.from({ length: 10 }, (_, i) => `第${i + 1}行`);
      writeFileSync(file, lines.join("\n") + "\n", "utf8");
      const result = await callRead(session.client, { path: "sliced.txt", offset: 4, limit: 3 });
      expectOk(result);
      const text = textOf(result);
      expect(text).toMatch(/4\t第4行/);
      expect(text).toMatch(/6\t第6行/);
      expect(text).not.toContain("第3行");
      expect(text).not.toContain("第7行");
    },
  );

  it(
    "offset 超出文件末尾时返回已有部分而不是报错",
    { timeout: 15_000 },
    async () => {
      const file = path.join(root, "tail.txt");
      writeFileSync(file, "一\n二\n三\n", "utf8");
      const partial = await callRead(session.client, { path: "tail.txt", offset: 2, limit: 50 });
      expectOk(partial);
      const text = textOf(partial);
      expect(text).toMatch(/2\t二/);
      expect(text).toMatch(/3\t三/);
      expect(text).not.toMatch(/1\t一/);

      const beyond = await callRead(session.client, { path: "tail.txt", offset: 99 });
      expectOk(beyond);
      expect(textOf(beyond)).toMatch(/共 3 行/);
      expect(textOf(beyond)).toContain("99");

      writeFileSync(path.join(root, "empty.txt"), "", "utf8");
      const empty = await callRead(session.client, { path: "empty.txt" });
      expectOk(empty);
      expect(textOf(empty)).toContain("空文件");
    },
  );

  it(
    "单次读取行数有上限，超限时提示用 offset 继续",
    { timeout: 15_000 },
    async () => {
      const file = path.join(root, "big.txt");
      const lines = Array.from({ length: 2100 }, (_, i) => `line-${i + 1}`);
      writeFileSync(file, lines.join("\n") + "\n", "utf8");
      const result = await callRead(session.client, { path: "big.txt" });
      expectOk(result);
      const text = textOf(result);
      expect(text).toMatch(/2000\tline-2000/);
      expect(text).not.toContain("line-2001");
      expect(text).toContain("offset=2001");
      expect(text).toContain("2100");

      const small = await callRead(session.client, { path: "big.txt", limit: 1 });
      expect(textOf(small)).toMatch(/1\tline-1/);
      expect(textOf(small)).toContain("offset=2");
    },
  );

  it(
    "单行超长文件触发字节上限时明确提示该行被截断及省略字节数，且不输出矛盾的 limit 缩小提示",
    { timeout: 15_000 },
    async () => {
      const file = path.join(root, "minified-single-line.js");
      writeFileSync(file, "var x = '" + "a".repeat(80_000) + "';\nconst secondLine = 2;\n", "utf8");
      const result = await callRead(session.client, { path: "minified-single-line.js" });
      expectOk(result);
      const text = textOf(result);
      expect(text).toContain("1\tvar x = '");
      expect(text).not.toContain("';");
      expect(text).toContain("超过字节上限");
      expect(text).toContain("字节");
      expect(text).toContain("offset=2");
      expect(text).not.toContain("用 limit 缩小范围");
    },
  );

  it(
    "非 UTF-8 文件返回可读错误，不返回乱码",
    { timeout: 15_000 },
    async () => {
      const file = path.join(root, "binary.dat");
      writeFileSync(file, Buffer.from([0xff, 0xfe, 0x41, 0x00, 0x9a]));
      const result = await callRead(session.client, { path: "binary.dat" });
      expect(result.isError).toBe(true);
      const text = textOf(result);
      expect(text).toContain("UTF-8");
      expect(text).not.toContain("\uFFFD");
    },
  );

  it(
    "write 整文件覆盖，内容按 UTF-8 编码，保留传入的换行风格",
    { timeout: 15_000 },
    async () => {
      const target = "crlf.txt";
      const written = await callWrite(session.client, {
        path: target,
        content: "第一行\r\nsecond line\r\n",
      });
      expectOk(written);
      expect(readFileSync(path.join(root, target))).toEqual(
        Buffer.from("第一行\r\nsecond line\r\n", "utf8"),
      );

      const overwrite = await callWrite(session.client, { path: target, content: "only" });
      expectOk(overwrite);
      expect(readFileSync(path.join(root, target), "utf8")).toBe("only");
    },
  );

  it(
    "写入的父目录不存在时返回可读错误，不自动创建",
    { timeout: 15_000 },
    async () => {
      const result = await callWrite(session.client, {
        path: "no-such-dir/deep/child.txt",
        content: "x",
      });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("目录");
      expect(existsSync(path.join(root, "no-such-dir"))).toBe(false);
    },
  );

  it(
    "越界路径一律拒绝，错误信息说明被拒绝的路径",
    { timeout: 20_000 },
    async (t) => {
      // .. 跳出
      const dotdot = await callWrite(session.client, { path: "../escape.txt", content: "x" });
      expect(dotdot.isError).toBe(true);
      expect(textOf(dotdot)).toContain("escape.txt");
      expect(existsSync(path.join(root, "..", "escape.txt"))).toBe(false);

      // 绝对路径指向根外
      const absOutside = await callRead(session.client, {
        path: path.join(root, "..", "outside-abs.txt"),
      });
      expect(absOutside.isError).toBe(true);
      expect(textOf(absOutside)).toContain("outside-abs.txt");

      // 符号链接指向根外（无特权时退回 junction，同样覆盖真实路径解析）
      writeFileSync(path.join(outside, "target.txt"), "secret", "utf8");
      const escaped = makeEscapeLink(root, outside);
      if (escaped) {
        const readEscape = await callRead(session.client, { path: escaped.readPath });
        expect(readEscape.isError).toBe(true);
        // 错误信息里带被拒绝的路径（绝对路径形式，分隔符跟随平台）
        expect(textOf(readEscape)).toContain(path.basename(escaped.readPath));

        const writeEscape = await callWrite(session.client, { path: escaped.writePath, content: "x" });
        expect(writeEscape.isError).toBe(true);
        expect(textOf(writeEscape)).toContain(path.basename(escaped.writePath));
      } else {
        t.skip();
      }
    },
  );

  it(
    "根目录本身不可写",
    { timeout: 15_000 },
    async () => {
      const dot = await callWrite(session.client, { path: ".", content: "x" });
      expect(dot.isError).toBe(true);
      expect(textOf(dot)).toContain("根目录");

      const absRoot = await callWrite(session.client, { path: root, content: "x" });
      expect(absRoot.isError).toBe(true);
      expect(textOf(absRoot)).toContain("根目录");
    },
  );

  it(
    "路径解析对 Windows 盘符与反斜杠正确处理",
    { timeout: 20_000 },
    async () => {
      mkdirSync(path.join(root, "sub"), { recursive: true });
      const written = await callWrite(session.client, { path: "sub\\back.txt", content: "反斜杠内容" });
      expectOk(written);
      expect(existsSync(path.join(root, "sub", "back.txt"))).toBe(true);

      const absBackslash = await callRead(session.client, {
        path: path.join(root, "sub", "back.txt"),
      });
      expectOk(absBackslash);
      expect(textOf(absBackslash)).toContain("反斜杠内容");

      const forwardSlash = await callRead(session.client, {
        path: root.replace(/\\/g, "/") + "/sub/back.txt",
      });
      expectOk(forwardSlash);
      expect(textOf(forwardSlash)).toContain("反斜杠内容");

      // .. 留在根内时放行
      const inner = await callRead(session.client, { path: "sub\\..\\crlf.txt" });
      expectOk(inner);
      expect(textOf(inner)).toContain("only");
    },
  );
});
