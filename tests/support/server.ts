import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

export interface RunningServer {
  port: number;
  panelPort: number;
  mcpUrl: URL;
  panelUrl: string;
  configPath: string;
  stderrText(): string;
  stop(): Promise<void>;
}

export interface StartOptions {
  token?: string;
  tunnelUrl?: string;
  /** config.json 的 tunnel 段，透传给服务的隧道管理器 */
  tunnel?: Record<string, unknown>;
  /** NEXUS_TUNNEL_STUB：插在 cloudflared 参数最前面的 stub 脚本路径 */
  tunnelStubPath?: string;
}

export function freePort(): Promise<number> {
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

function waitForPort(port: number, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = net.connect({ port, host: "127.0.0.1" });
      socket.once("connect", () => {
        socket.destroy();
        resolve();
      });
      socket.once("error", () => {
        socket.destroy();
        if (Date.now() > deadline) {
          reject(new Error(`服务在 ${timeoutMs}ms 内没有监听 ${port}`));
          return;
        }
        setTimeout(attempt, 50);
      });
    };
    attempt();
  });
}

/** 起一个真实的 dist 进程；面板与 MCP 各占一个空闲端口 */
export async function startServer(options: StartOptions = {}): Promise<RunningServer> {
  const port = await freePort();
  const panelPort = await freePort();
  const configDir = mkdtempSync(path.join(os.tmpdir(), "nexus-mcp-test-"));
  const configPath = path.join(configDir, "config.json");
  writeFileSync(
    configPath,
    JSON.stringify(
      {
        root: projectRoot,
        transport: "http",
        port,
        panelPort,
        token: options.token ?? "",
        shell: "auto",
        ...(options.tunnelUrl ? { tunnelUrl: options.tunnelUrl } : {}),
        // 默认把 metrics 端口钉到 1：跑测试的机器上可能有真 cloudflared 占着 20241，
        // 不隔离的话隧道用例会被机器状态带偏。用例要测就自己传 metricsPort 覆盖。
        ...(options.tunnel ? { tunnel: { metricsPort: 1, ...options.tunnel } } : {}),
      },
      null,
      2,
    ),
    "utf8",
  );

  const child: ChildProcess = spawn(process.execPath, [path.join(projectRoot, "dist", "index.js")], {
    cwd: projectRoot,
    env: {
      ...process.env,
      NEXUS_MCP_CONFIG: configPath,
      // 测试机上可能跑着真隧道，外部进程检测一律关闭，用例只管自己拉起的进程
      NEXUS_TUNNEL_EXTERNAL: "off",
      ...(options.tunnelStubPath ? { NEXUS_TUNNEL_STUB: options.tunnelStubPath } : {}),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });

  try {
    await waitForPort(port);
    await waitForPort(panelPort);
  } catch (error) {
    child.kill();
    rmSync(configDir, { recursive: true, force: true });
    throw new Error(`${(error as Error).message}\n服务输出:\n${stderr}`);
  }

  return {
    port,
    panelPort,
    mcpUrl: new URL(`http://127.0.0.1:${port}/mcp`),
    panelUrl: `http://127.0.0.1:${panelPort}`,
    configPath,
    stderrText: () => stderr,
    async stop() {
      child.kill();
      rmSync(configDir, { recursive: true, force: true });
      await new Promise<void>((resolve) => {
        child.once("exit", () => resolve());
        setTimeout(resolve, 3000);
      });
    },
  };
}
