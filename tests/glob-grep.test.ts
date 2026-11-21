import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  utimesSync,
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
  const client = new Client({ name: "vitest-glob-grep", version: "0.1.0" });
  await client.connect(transport);
  return {
    client,
    async close() {
      await client.close();
    },
  };
}

async function callGlob(client: Client, args: Record<string, unknown>): Promise<ToolResult> {
  return (await client.callTool({ name: "glob", arguments: args })) as ToolResult;
}

async function callGrep(client: Client, args: Record<string, unknown>): Promise<ToolResult> {
  return (await client.callTool({ name: "grep", arguments: args })) as ToolResult;
}

/** 路径列表是输出的第一段（尾注用空行隔开） */
function pathLines(result: ToolResult): string[] {
  const [body] = textOf(result).split("\n\n");
  return body.split("\n").filter((line) => line.includes("/"));
}

describe("glob/grep 工具", () => {
  let session: StdioSession;
  let root: string;
  let configDir: string;

  beforeAll(async () => {
    root = mkdtempSync(path.join(os.tmpdir(), "nexus-gg-root-"));
    configDir = mkdtempSync(path.join(os.tmpdir(), "nexus-gg-cfg-"));
    // WalkBuilder/rg 都按 require_git 语义只认 git 仓库里的 ignore 规则
    execFileSync("git", ["init", "--quiet", root]);
    writeFileSync(path.join(root, ".gitignore"), "node_modules/\ndist/\n", "utf8");

    mkdirSync(path.join(root, "src"), { recursive: true });
    mkdirSync(path.join(root, "docs"), { recursive: true });
    mkdirSync(path.join(root, "node_modules", "pkg"), { recursive: true });
    mkdirSync(path.join(root, "dist"), { recursive: true });
    mkdirSync(path.join(root, "many"), { recursive: true });
    mkdirSync(path.join(root, "sort"), { recursive: true });

    writeFileSync(
      path.join(root, "src", "app.ts"),
      "const hello = 'app';\nfoo();\nconst world = 1;\nHello Mixed Case\n",
      "utf8",
    );
    writeFileSync(path.join(root, "src", "util.ts"), "export function hello() {}\n", "utf8");
    writeFileSync(path.join(root, "docs", "readme.md"), "# Readme\nhello markdown\n", "utf8");
    writeFileSync(path.join(root, "node_modules", "pkg", "index.ts"), "hello from dependency\n", "utf8");
    writeFileSync(path.join(root, "dist", "out.ts"), "hello built\n", "utf8");
    // 含 NUL 字节：rg 按二进制检测跳过，不产生匹配
    writeFileSync(
      path.join(root, "binary.dat"),
      Buffer.concat([Buffer.from("prefix "), Buffer.from([0x00]), Buffer.from("hello binary\n")]),
    );
    for (let i = 0; i < 120; i++) {
      writeFileSync(path.join(root, "many", `f${String(i).padStart(3, "0")}.txt`), `file ${i}\n`, "utf8");
    }
    const needles = Array.from({ length: 120 }, (_, i) => `needle ${i + 1}`);
    writeFileSync(path.join(root, "grepbig.txt"), needles.join("\n") + "\n", "utf8");

    // mtime 从旧到新：a < b < c（utimes 强制拉开差距，避免文件系统时间精度问题）
    const base = 1_000_000_000_000;
    for (const [name, delta] of [["a.txt", 0], ["b.txt", 2000], ["c.txt", 4000]] as const) {
      const file = path.join(root, "sort", name);
      writeFileSync(file, name, "utf8");
      const when = new Date(base + delta);
      utimesSync(file, when, when);
    }

    const configPath = path.join(configDir, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({ root, transport: "stdio", shell: "auto" }, null, 2),
      "utf8",
    );
    session = await connectStdio({ NEXUS_MCP_CONFIG: configPath });
  }, 60_000);

  afterAll(async () => {
    await session?.close();
    for (const dir of [root, configDir]) {
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  it(
    "glob 返回匹配路径，按修改时间从新到旧",
    { timeout: 15_000 },
    async () => {
      const result = await callGlob(session.client, { pattern: "*.txt", path: "sort" });
      expect(result.isError).toBeFalsy();
      expect(pathLines(result)).toEqual(["sort/c.txt", "sort/b.txt", "sort/a.txt"]);
    },
  );

  it(
    "glob 默认遵守 .gitignore，不返回 node_modules、dist 里的文件",
    { timeout: 15_000 },
    async () => {
      const result = await callGlob(session.client, { pattern: "**/*.ts" });
      expect(result.isError).toBeFalsy();
      const paths = pathLines(result);
      expect(paths).toContain("src/app.ts");
      expect(paths).toContain("src/util.ts");
      expect(paths).not.toContain("node_modules/pkg/index.ts");
      expect(paths).not.toContain("dist/out.ts");
    },
  );

  it(
    "glob 支持指定搜索起点，起点越界或不存在时报错",
    { timeout: 15_000 },
    async () => {
      const inside = await callGlob(session.client, { pattern: "*.md", path: "docs" });
      expect(inside.isError).toBeFalsy();
      expect(pathLines(inside)).toEqual(["docs/readme.md"]);

      const dotdot = await callGlob(session.client, { pattern: "*.md", path: "../" });
      expect(dotdot.isError).toBe(true);
      expect(textOf(dotdot)).toContain("越界");

      const absOutside = await callGlob(session.client, {
        pattern: "*.md",
        path: path.join(root, "..", "outside-gg"),
      });
      expect(absOutside.isError).toBe(true);

      const missing = await callGlob(session.client, { pattern: "*.md", path: "no-such-dir" });
      expect(missing.isError).toBe(true);
      expect(textOf(missing)).toContain("目录");
    },
  );

  it(
    "glob 剪掉指向根外的符号链接，不列出越界文件",
    { timeout: 15_000 },
    async () => {
      const outsideDir = mkdtempSync(path.join(os.tmpdir(), "nexus-gg-out-"));
      try {
        writeFileSync(path.join(outsideDir, "secret.txt"), "secret", "utf8");
        // 目录 junction 免特权；造不出来（极端受限环境）就跳过断言
        let linked = false;
        try {
          symlinkSync(outsideDir, path.join(root, "leakdir"), "junction");
          linked = true;
        } catch {
          // ignore
        }
        if (linked) {
          const result = await callGlob(session.client, { pattern: "**/*.txt" });
          expect(result.isError).toBeFalsy();
          expect(textOf(result)).not.toContain("leakdir");
          expect(textOf(result)).not.toContain("secret.txt");
        }
      } finally {
        // 先摘 junction 再删目标目录，悬空链接不能留在 root 里影响后续用例
        rmSync(path.join(root, "leakdir"), { force: true, recursive: true });
        rmSync(outsideDir, { recursive: true, force: true });
      }
    },
  );

  it(
    "grep 返回文件名、行号和匹配行内容",
    { timeout: 30_000 },
    async () => {
      const result = await callGrep(session.client, { pattern: "world" });
      expect(result.isError).toBeFalsy();
      expect(textOf(result)).toContain("src/app.ts:3: const world = 1;");
    },
  );

  it(
    "grep 的 glob 参数限定文件范围",
    { timeout: 30_000 },
    async () => {
      const result = await callGrep(session.client, { pattern: "hello", glob: "*.md" });
      expect(result.isError).toBeFalsy();
      expect(textOf(result)).toContain("docs/readme.md:2: hello markdown");
      expect(textOf(result)).not.toContain("src/app.ts");
    },
  );

  it(
    "grep 默认区分大小写，ignore_case 打开后匹配大写行",
    { timeout: 30_000 },
    async () => {
      const sensitive = await callGrep(session.client, { pattern: "hello mixed" });
      expect(sensitive.isError).toBeFalsy();
      expect(textOf(sensitive)).toContain("没有匹配");

      const insensitive = await callGrep(session.client, {
        pattern: "hello mixed",
        ignore_case: true,
      });
      expect(insensitive.isError).toBeFalsy();
      expect(textOf(insensitive)).toContain("src/app.ts:4: Hello Mixed Case");
    },
  );

  it(
    "ripgrep 未安装时返回明确提示，不当作空结果",
    { timeout: 30_000 },
    async () => {
      // PATH 清空（PATH 查找必 miss）+ 跳过缓存与下载 → 走到「未安装」分支
      const offline = await connectStdio({
        NEXUS_MCP_CONFIG: path.join(configDir, "config.json"),
        PATH: "",
        NEXUS_MCP_RG_SKIP_DOWNLOAD: "1",
      });
      try {
        const result = await callGrep(offline.client, { pattern: "hello" });
        expect(result.isError).toBe(true);
        const text = textOf(result);
        expect(text).toMatch(/ripgrep/i);
        expect(text).toContain("安装");
      } finally {
        await offline.close();
      }
    },
  );

  it(
    "结果数量超限时截断并说明还有更多",
    { timeout: 15_000 },
    async () => {
      const globResult = await callGlob(session.client, { pattern: "*.txt", path: "many" });
      expect(globResult.isError).toBeFalsy();
      expect(pathLines(globResult)).toHaveLength(100);
      const globText = textOf(globResult);
      expect(globText).toContain("共 120 个");
      expect(globText).toContain("还有更多");

      const grepResult = await callGrep(session.client, { pattern: "needle" });
      expect(grepResult.isError).toBeFalsy();
      const grepText = textOf(grepResult);
      const grepLines = grepText.split("\n");
      // 100 条匹配行 + 尾注前的空行 + 尾注
      expect(grepLines.filter((line) => line.includes("needle"))).toHaveLength(100);
      expect(grepLines[99]).toBe("grepbig.txt:100: needle 100");
      expect(grepText).not.toContain("needle 101");
      expect(grepText).toContain("还有更多");
    },
  );

  it(
    "无匹配时返回空结果加说明，不当作错误",
    { timeout: 15_000 },
    async () => {
      const globResult = await callGlob(session.client, { pattern: "zzz-*.nomatch" });
      expect(globResult.isError).toBeFalsy();
      expect(textOf(globResult)).toContain("没有匹配");

      const grepResult = await callGrep(session.client, { pattern: "nomatch-zzz-xyz" });
      expect(grepResult.isError).toBeFalsy();
      expect(textOf(grepResult)).toContain("没有匹配");
    },
  );

  it(
    "二进制文件被跳过，不把乱码塞进结果",
    { timeout: 30_000 },
    async () => {
      const result = await callGrep(session.client, { pattern: "hello" });
      expect(result.isError).toBeFalsy();
      const text = textOf(result);
      expect(text).toContain("src/app.ts:1: const hello = 'app';");
      expect(text).toContain("src/util.ts:1: export function hello() {}");
      expect(text).toContain("docs/readme.md:2: hello markdown");
      expect(text).not.toContain("binary.dat");
      expect(text).not.toContain("\uFFFD");
    },
  );
});
