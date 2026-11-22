/**
 * 打包产物冒烟：拿 build/package 当「用户解压后的目录」，在最小环境下跑一遍。
 *
 * 覆盖的验收线：
 * - 不装 Node / Rust / Git 也能起来（PATH 只留 System32，NEXUS_GIT_BASH 指向不存在的文件）
 * - 首次运行自动生成 config.json，root 落在 exe 同目录的 workspace
 * - 通过 MCP 客户端入口连上并调一次 read
 * - 面板起得来，地址与端口和配置一致，版本号可见
 *
 * 用法：`npm run package` 之后跑 `npm run package:smoke`。
 */
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stageDir = path.join(root, "build", "package");
const appDir = path.join(mkdtempSync(path.join(os.tmpdir(), "nexus-mcp-pkg-smoke-")), "app");
const sysRoot = process.env.SystemRoot ?? "C:\\Windows";
const version = (JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as { version: string })
  .version;

function check(ok: boolean, message: string): void {
  if (ok) {
    console.log(`  ok  ${message}`);
    return;
  }
  console.error(`  NG  ${message}`);
  cleanup();
  process.exit(1);
}

/**
 * Windows 上刚被 kill 的进程还会短暂占着 exe，删目录要重试。
 * 重试仍失败只警告：临时目录残留是环境噪音，不该把冒烟结论带成失败。
 */
function cleanup(): void {
  const target = path.dirname(appDir);
  try {
    rmSync(target, { recursive: true, force: true, maxRetries: 30, retryDelay: 200 });
  } catch (error) {
    console.error(`  (临时目录没删干净，可手动删 ${target}：${(error as Error).message})`);
  }
}

/** 等子进程真的退出，否则紧接着删目录会 EPERM */
function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 5000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill();
  });
}

/** 模拟一台什么都没装的机器：PATH 只有系统目录，Git Bash 指到不存在的路径 */
function minimalEnv(): Record<string, string> {
  return {
    PATH: `${path.join(sysRoot, "System32")};${sysRoot}`,
    SystemRoot: sysRoot,
    TEMP: os.tmpdir(),
    TMP: os.tmpdir(),
    USERPROFILE: path.join(path.dirname(appDir), "user"),
    LOCALAPPDATA: path.join(path.dirname(appDir), "local"),
    APPDATA: path.join(path.dirname(appDir), "roaming"),
    NEXUS_GIT_BASH: path.join(path.dirname(appDir), "no-git", "bash.exe"),
  };
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

function waitForPort(port: number, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = (): void => {
      const socket = net.connect({ port, host: "127.0.0.1" });
      socket.once("connect", () => {
        socket.destroy();
        resolve();
      });
      socket.once("error", () => {
        socket.destroy();
        if (Date.now() > deadline) {
          reject(new Error(`端口 ${port} 在 ${timeoutMs}ms 内没有监听`));
          return;
        }
        setTimeout(attempt, 50);
      });
    };
    attempt();
  });
}

async function smokeStdio(): Promise<void> {
  console.log("\n== stdio：连上并调一次 read");
  const exe = path.join(appDir, "nexus-mcp.exe");
  const transport = new StdioClientTransport({
    command: exe,
    args: ["--stdio"],
    cwd: appDir,
    env: minimalEnv(),
    stderr: "inherit",
  });

  const client = new Client({ name: "nexus-mcp-package-smoke", version: "0" });
  await client.connect(transport);

  const listed = await client.listTools();
  check(listed.tools.length === 9, `工具数量为 9（实际 ${listed.tools.length}）`);

  const workspace = path.join(appDir, "workspace");
  check(existsSync(workspace), "首次运行建出了 workspace 目录");

  const configFile = path.join(appDir, "config.json");
  check(existsSync(configFile), "首次运行生成了 config.json");
  const config = JSON.parse(readFileSync(configFile, "utf8")) as { token?: string; root?: string };
  check(/^[0-9a-f]{32}$/.test(config.token ?? ""), "config.json 里带随机令牌");
  check(
    path.resolve(config.root ?? "").toLowerCase() === workspace.toLowerCase(),
    "默认根目录指向 exe 同目录的 workspace",
  );

  mkdirSync(workspace, { recursive: true });
  writeFileSync(path.join(workspace, "probe.txt"), "打包冒烟标记 PACKAGE-SMOKE-OK\n", "utf8");
  const result = await client.callTool({ name: "read", arguments: { path: "probe.txt" } });
  check(!result.isError, "read 没有返回错误");
  check(JSON.stringify(result).includes("PACKAGE-SMOKE-OK"), "read 读回了探针文件内容");

  await client.close();
}

async function smokePanel(): Promise<void> {
  console.log("\n== http：面板地址、端口与版本号");
  const port = await freePort();
  const panelPort = await freePort();
  const configFile = path.join(appDir, "config.json");
  const config = JSON.parse(readFileSync(configFile, "utf8")) as Record<string, unknown>;
  writeFileSync(
    configFile,
    `${JSON.stringify({ ...config, transport: "http", port, panelPort }, null, 2)}\n`,
    "utf8",
  );

  const child = spawn(path.join(appDir, "nexus-mcp.exe"), [], {
    cwd: appDir,
    env: minimalEnv(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });

  try {
    await waitForPort(port);
    await waitForPort(panelPort);

    const status = (await (await fetch(`http://127.0.0.1:${panelPort}/api/status`)).json()) as {
      service: { port: number; url: string };
      panelPort: number;
      version: string;
      root: string;
    };
    check(status.service.port === port, `MCP 端口为 ${port}`);
    check(
      status.service.url === `http://127.0.0.1:${port}/mcp`,
      `MCP 地址为 http://127.0.0.1:${port}/mcp`,
    );
    check(status.panelPort === panelPort, `面板端口为 ${panelPort}`);
    check(status.version === version, `状态接口版本号是 ${version}`);
    check(
      path.resolve(status.root).toLowerCase() === path.join(appDir, "workspace").toLowerCase(),
      "根目录是 exe 同目录的 workspace",
    );

    const html = await (await fetch(`http://127.0.0.1:${panelPort}/`)).text();
    check(html.includes(`id="app-version"`) && html.includes(`v${version}`), "面板页头印着版本号");
    check(html.includes(`id="restart"`) && html.includes("color-scheme: light"), "面板是日间版并带重启按钮");
  } catch (error) {
    console.error(`服务输出：\n${stderr}`);
    throw error;
  } finally {
    await stopChild(child);
  }
}

async function main(): Promise<void> {
  if (!existsSync(path.join(stageDir, "nexus-mcp.exe"))) {
    console.error("先跑 npm run package 产出 build/package。");
    process.exit(1);
  }

  // 等同用户解压 zip：拷一份干净目录，不带任何开发文件
  cpSync(stageDir, appDir, { recursive: true });

  try {
    await smokeStdio();
    await smokePanel();
    console.log(`\n打包冒烟通过，版本 ${version}`);
  } finally {
    cleanup();
  }
}

main().catch((error: unknown) => {
  console.error(`\n打包冒烟失败：${(error as Error).message}`);
  cleanup();
  process.exit(1);
});
