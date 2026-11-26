import { expectOk } from "./support/tool.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { projectRoot } from "./support/server.js";
import { crashHelperBinaryPath } from "../src/executor.js";

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

/** 起一个 stdio 模式的真实 dist 进程，env 透传给服务进程（用来覆盖执行器路径等） */
async function connectStdio(env: Record<string, string> = {}): Promise<StdioSession> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(projectRoot, "dist", "index.js"), "--stdio"],
    cwd: projectRoot,
    env: { ...process.env, ...env } as Record<string, string>,
    stderr: "ignore",
  });
  const client = new Client({ name: "vitest-bash", version: "0.1.0" });
  await client.connect(transport);
  return {
    client,
    async close() {
      await client.close();
    },
  };
}

async function callBash(client: Client, args: Record<string, unknown>): Promise<ToolResult> {
  return (await client.callTool({ name: "bash", arguments: args })) as ToolResult;
}

interface TempConfig {
  path: string;
  dir: string;
}

function writeTempConfig(overrides: Record<string, unknown> = {}): TempConfig {
  const dir = mkdtempSync(path.join(os.tmpdir(), "nexus-mcp-cfg-"));
  const configPath = path.join(dir, "config.json");
  writeFileSync(
    configPath,
    JSON.stringify({ root: projectRoot, transport: "stdio", ...overrides }, null, 2),
    "utf8",
  );
  return { path: configPath, dir };
}

/** 起 dist 进程等到它退出，收集 stderr；用于验证启动即报错的配置 */
function serverStderr(configPath: string, env: Record<string, string> = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(projectRoot, "dist", "index.js"), "--stdio"], {
      cwd: projectRoot,
      env: { ...process.env, NEXUS_MCP_CONFIG: configPath, ...env } as Record<string, string>,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let collected = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      collected += chunk;
    });
    child.on("exit", () => resolve(collected));
    child.on("error", reject);
  });
}

describe("bash 工具", () => {
  let session: StdioSession;
  // 自带隔离配置：不读仓库根的 config.json（那里是部署配置，root 不是 projectRoot）
  let mainConfig: TempConfig;

  beforeAll(async () => {
    mainConfig = writeTempConfig();
    session = await connectStdio({ NEXUS_MCP_CONFIG: mainConfig.path });
  }, 30_000);

  afterAll(async () => {
    await session?.close();
    rmSync(mainConfig.dir, { recursive: true, force: true });
  });

  it(
    "执行命令并返回输出与退出码",
    { timeout: 15_000 },
    async () => {
      const result = await callBash(session.client, { command: "echo hello-nexus" });
      expectOk(result);
      const text = textOf(result);
      expect(text).toContain("exit_code: 0");
      expect(text).toContain("hello-nexus");
    },
  );

  it(
    "在给定工作目录执行命令",
    { timeout: 15_000 },
    async () => {
      const result = await callBash(session.client, { command: "pwd", cwd: "docs" });
      expectOk(result);
      expect(textOf(result)).toContain("docs");
    },
  );

  it(
    "cwd 通过目录链接指向沙箱根外时被拒绝，且盘符大小写差异不误拒合法根内目录",
    { timeout: 20_000 },
    async (t) => {
      const sandboxRoot = mkdtempSync(path.join(os.tmpdir(), "nexus-bash-root-"));
      const outsideDir = mkdtempSync(path.join(os.tmpdir(), "nexus-bash-out-"));
      const subDir = path.join(sandboxRoot, "sub");
      mkdirSync(subDir, { recursive: true });
      const linkPath = path.join(sandboxRoot, "escape-link");
      let linked = false;
      try {
        symlinkSync(outsideDir, linkPath, "junction");
        linked = true;
      } catch {
        // 极端受限环境无法建 junction 时跳过
      }
      const cfg = writeTempConfig({ root: sandboxRoot });
      const isolated = await connectStdio({ NEXUS_MCP_CONFIG: cfg.path });
      try {
        if (!linked) {
          t.skip();
          return;
        }
        const escaped = await callBash(isolated.client, { command: "pwd", cwd: "escape-link" });
        expect(escaped.isError).toBe(true);
        expect(textOf(escaped)).toContain("路径越界");

        if (process.platform === "win32" && /^[A-Za-z]:/.test(subDir)) {
          const flippedDrive =
            (subDir[0] === subDir[0]!.toUpperCase()
              ? subDir[0]!.toLowerCase()
              : subDir[0]!.toUpperCase()) + subDir.slice(1);
          const valid = await callBash(isolated.client, { command: "pwd", cwd: flippedDrive });
          expectOk(valid);
        }

        // 纯空白 cwd 应与空串一致回退到沙箱根，不得误报 "path 不能为空"
        const blankCwd = await callBash(isolated.client, { command: "echo blank-cwd-ok", cwd: "   " });
        expectOk(blankCwd);
        expect(textOf(blankCwd)).toContain("blank-cwd-ok");
      } finally {
        await isolated.close();
        rmSync(linkPath, { recursive: true, force: true });
        rmSync(sandboxRoot, { recursive: true, force: true });
        rmSync(outsideDir, { recursive: true, force: true });
        rmSync(cfg.dir, { recursive: true, force: true });
      }
    },
  );

  it(
    "合并标准错误，退出码非零仍正常返回",
    { timeout: 15_000 },
    async () => {
      const result = await callBash(session.client, {
        command: "echo 到标准错误 >&2; printf '到标准输出'; exit 3",
      });
      expectOk(result);
      const text = textOf(result);
      expect(text).toContain("exit_code: 3");
      expect(text).toContain("到标准错误");
      expect(text).toContain("到标准输出");
    },
  );

  it(
    "中文输出不乱码",
    { timeout: 15_000 },
    async () => {
      const result = await callBash(session.client, { command: "echo 你好，世界" });
      expectOk(result);
      expect(textOf(result)).toContain("你好，世界");
    },
  );

  it(
    "Git Bash 环境变量按约定设置",
    { timeout: 15_000 },
    async () => {
      const result = await callBash(session.client, {
        command: 'echo "$LANG|$LC_ALL|$MSYS_NO_PATHCONV"',
      });
      expectOk(result);
      expect(textOf(result)).toContain("zh_CN.UTF-8|C.UTF-8|1");
    },
  );

  it(
    "超过 timeout_ms 的命令被终止并返回超时信息",
    { timeout: 15_000 },
    async () => {
      const started = Date.now();
      const result = await callBash(session.client, { command: "sleep 5", timeout_ms: 1000 });
      const elapsed = Date.now() - started;
      expectOk(result);
      const text = textOf(result);
      expect(text).toContain("timed_out");
      expect(elapsed).toBeLessThan(8_000);
    },
  );

  it(
    "超长输出保留头尾并标注省略的字节数",
    { timeout: 15_000 },
    async () => {
      const result = await callBash(session.client, { command: "seq 1 20000" });
      expectOk(result);
      const text = textOf(result);
      expect(text).toContain("bytes omitted");
      expect(text).toContain("1\n2");
      expect(text).toContain("20000");
    },
  );

  it(
    "中文长输出截断后不产生乱码",
    { timeout: 15_000 },
    async () => {
      const result = await callBash(session.client, {
        command: 'for i in $(seq 1 10000); do echo "第${i}行"; done',
      });
      expectOk(result);
      const text = textOf(result);
      expect(text).toContain("bytes omitted");
      expect(text).not.toContain("\uFFFD");
    },
  );

  it(
    "非 UTF-8 字节出现在超长输出头部时不丢弃后续头部内容",
    { timeout: 15_000 },
    async () => {
      const result = await callBash(session.client, {
        command: "printf 'HEAD_BEFORE\\xff\\xfeHEAD_AFTER\\n'; seq 1 20000",
      });
      expectOk(result);
      const text = textOf(result);
      expect(text).toContain("bytes omitted");
      expect(text).toContain("HEAD_BEFORE");
      expect(text).toContain("HEAD_AFTER");
    },
  );
});

describe("执行器意外退出", () => {
  it(
    "协议层返回可读错误而不是挂起",
    { timeout: 20_000 },
    async () => {
      const cfg = writeTempConfig();
      const session = await connectStdio({
        NEXUS_MCP_CONFIG: cfg.path,
        NEXUS_MCP_EXECUTOR: crashHelperBinaryPath(),
      });
      try {
        const result = await callBash(session.client, { command: "echo hi" });
        expect(result.isError).toBe(true);
        const text = textOf(result);
        expect(text).toContain("执行器");
        expect(text).toContain("意外退出");
      } finally {
        await session.close();
        rmSync(cfg.dir, { recursive: true, force: true });
      }
    },
  );
});

describe("shell 配置校验", () => {
  it(
    "显式配置 PowerShell 5.1 时启动即报错并说明原因",
    { timeout: 20_000 },
    async () => {
      const config = writeTempConfig({ shell: "powershell" });
      try {
        const stderr = await serverStderr(config.path);
        expect(stderr).toContain("5.1");
        expect(stderr).toContain("pwsh");
      } finally {
        rmSync(config.dir, { recursive: true, force: true });
      }
    },
  );

  it(
    "shell 为 auto 但找不到 Git Bash 时启动即报错",
    { timeout: 20_000 },
    async () => {
      const config = writeTempConfig({ shell: "auto" });
      try {
        const stderr = await serverStderr(config.path, {
          NEXUS_GIT_BASH: "X:\\不存在的路径\\bash.exe",
        });
        expect(stderr).toContain("Git Bash");
        expect(stderr).toContain("pwsh");
      } finally {
        rmSync(config.dir, { recursive: true, force: true });
      }
    },
  );

  it(
    "shell 为 pwsh 时命令经 PowerShell 7 执行且中文不乱码",
    { timeout: 20_000 },
    async () => {
      const config = writeTempConfig({ shell: "pwsh" });
      const session = await connectStdio({ NEXUS_MCP_CONFIG: config.path });
      try {
        const result = await callBash(session.client, {
          command: 'Write-Output "pwsh-中文-7"',
        });
        expectOk(result);
        const text = textOf(result);
        expect(text).toContain("exit_code: 0");
        expect(text).toContain("pwsh-中文-7");
      } finally {
        await session.close();
        rmSync(config.dir, { recursive: true, force: true });
      }
    },
  );
});
