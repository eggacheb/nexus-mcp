import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { TunnelManager } from "../src/tunnel.js";
import type { TunnelManagerOptions } from "../src/tunnel.js";
import { projectRoot, startServer } from "./support/server.js";
import type { RunningServer } from "./support/server.js";

const TOKEN = "tunnel-token-3c9f21";

/** 轮询直到条件成立或超时，避免 sleep 定时带来的脆弱断言 */
async function waitFor(
  predicate: () => Promise<boolean> | boolean,
  timeoutMs = 8000,
  stepMs = 100,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
  throw new Error(`waitFor 超时 (${timeoutMs}ms)`);
}

/**
 * cloudflared 冒充脚本：参数与真 cloudflared 一致（--config/--logfile/tunnel run）。
 * 环境变量 NEXUS_STUB_EXIT_FILE 指向存在的文件时，启动即以其内容为退出码退出（模拟崩溃）；
 * 否则常驻（模拟正常隧道进程）。
 */
const STUB_SOURCE = `
const args = process.argv.slice(2);
const fs = require("fs");
const li = args.indexOf("--logfile");
const logfile = li >= 0 ? args[li + 1] : null;
if (logfile) fs.appendFileSync(logfile, "stub: tunnel started\\n");
const flagFile = process.env.NEXUS_STUB_EXIT_FILE;
if (flagFile && fs.existsSync(flagFile)) {
  const code = parseInt(fs.readFileSync(flagFile, "utf8").trim(), 10) || 7;
  if (logfile) fs.appendFileSync(logfile, "stub: simulated failure error code 1033\\n");
  process.exit(code);
}
setInterval(() => {}, 1000);
`;

interface StatusBody {
  service: { state: string; label: string; port: number; url: string; sessions: number };
  tunnel: {
    state: string;
    label: string;
    detail?: string;
    url?: string;
    process?: {
      running: boolean;
      managed: boolean;
      pid?: number;
      exitCode?: number;
      autoRestarting?: boolean;
      tail?: string[];
    };
  };
}

async function getStatus(server: RunningServer): Promise<StatusBody> {
  const response = await fetch(`${server.panelUrl}/api/status`);
  expect(response.status).toBe(200);
  return (await response.json()) as StatusBody;
}

async function postTunnel(
  server: RunningServer,
  action: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${server.panelUrl}/api/tunnel`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ action }),
  });
}

function stubOptions(workDir: string, overrides: Partial<TunnelManagerOptions> = {}): TunnelManagerOptions {
  const configPath = path.join(workDir, "config.yml");
  writeFileSync(configPath, "tunnel: stub\n", "utf8");
  return {
    cloudflaredPath: process.execPath,
    configPath,
    logfilePath: path.join(workDir, "tunnel.log"),
    autoRestart: false,
    argsPrefix: [path.join(workDir, "tunnel-stub.cjs")],
    // 默认与机器上的真隧道隔离；外部进程相关用例自行覆盖这个桩
    isRunningExternal: async () => false,
    ...overrides,
  };
}

describe("TunnelManager（进程级）", () => {
  let workDir: string;

  beforeAll(() => {
    workDir = mkdtempSync(path.join(os.tmpdir(), "nexus-mcp-tunnel-"));
    writeFileSync(path.join(workDir, "tunnel-stub.cjs"), STUB_SOURCE, "utf8");
  });

  afterAll(() => {
    delete process.env.NEXUS_STUB_EXIT_FILE;
    rmSync(workDir, { recursive: true, force: true });
  });

  it("找不到 cloudflared 或隧道配置时启动报错", async () => {
    const missing = stubOptions(workDir);
    missing.cloudflaredPath = path.join(workDir, "no-such-cloudflared.exe");
    const manager = new TunnelManager(missing);
    await expect(manager.start()).rejects.toThrow(/找不到 cloudflared/);

    const noConfig = stubOptions(workDir);
    noConfig.configPath = path.join(workDir, "no-such-config.yml");
    await expect(new TunnelManager(noConfig).start()).rejects.toThrow(/找不到隧道配置/);
  });

  it("进程退出时记录退出码与日志尾部", async () => {
    const flagFile = path.join(workDir, "exit-flag-1");
    writeFileSync(flagFile, "7", "utf8");
    process.env.NEXUS_STUB_EXIT_FILE = flagFile;
    try {
      const manager = new TunnelManager(stubOptions(workDir));
      const started = await manager.start();
      expect(started.started).toBe(true);
      expect(started.pid).toBeGreaterThan(0);

      await waitFor(() => manager.status().then((s) => !s.running && s.exitCode === 7));
      const status = await manager.status();
      expect(status.running).toBe(false);
      expect(status.exitCode).toBe(7);
      expect(status.lastExitAt).toBeTruthy();
      expect((status.tail ?? []).join("\n")).toContain("simulated failure");
    } finally {
      delete process.env.NEXUS_STUB_EXIT_FILE;
    }
  });

  it(
    "守护：异常退出后自动拉回新进程，stop 后不再重启",
    async () => {
      const flagFile = path.join(workDir, "exit-flag-2");
      writeFileSync(flagFile, "7", "utf8");
      process.env.NEXUS_STUB_EXIT_FILE = flagFile;
      try {
        const manager = new TunnelManager(
          stubOptions(workDir, {
            autoRestart: true,
            restartDelayMs: 300,
            // 这条用例不关心外部进程检测，注入 false 免去每轮 tasklist 的开销
            isRunningExternal: async () => false,
          }),
        );
        const first = await manager.start();
        expect(first.pid).toBeGreaterThan(0);

        await waitFor(() => manager.status().then((s) => s.autoRestarting === true));
        // 删掉标记文件，让下一次拉起的 stub 常驻
        rmSync(flagFile, { force: true });

        await waitFor(async () => {
          const s = await manager.status();
          return s.running && s.managed && s.pid !== first.pid;
        });
        const revived = await manager.status();
        expect(revived.exitCode).toBe(7);

        await manager.stop();
        await waitFor(() => manager.status().then((s) => !s.running));
        // 守护必须被 stop 掐断：等过重启延迟后仍然没有新进程
        await new Promise((resolve) => setTimeout(resolve, 1200));
        expect((await manager.status()).running).toBe(false);
      } finally {
        delete process.env.NEXUS_STUB_EXIT_FILE;
      }
    },
    20_000,
  );

  it("外部已运行的 cloudflared 被采用而不重复拉起", async () => {
    let external = true;
    const manager = new TunnelManager(
      stubOptions(workDir, { isRunningExternal: async () => external }),
    );
    const status = await manager.status();
    expect(status.running).toBe(true);
    expect(status.managed).toBe(false);

    const start = await manager.start();
    expect(start.started).toBe(false);
    expect(start.reason).toContain("外部");

    // stop 应该容错（taskkill 找不到 cloudflared.exe 也不抛）
    external = false;
    await expect(manager.stop()).resolves.toBeUndefined();
  });
});

describe("面板隧道卡（真实 dist 进程 + stub cloudflared）", () => {
  let server: RunningServer;
  let fakeServer: http.Server;
  let fakePort = 0;
  let workDir: string;

  beforeAll(async () => {
    delete process.env.NEXUS_STUB_EXIT_FILE;
    workDir = mkdtempSync(path.join(os.tmpdir(), "nexus-mcp-tunnel-panel-"));
    writeFileSync(path.join(workDir, "tunnel-stub.cjs"), STUB_SOURCE, "utf8");

    fakeServer = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, service: "fake-tunnel" }));
    });
    await new Promise<void>((resolve) => fakeServer.listen(0, "127.0.0.1", () => resolve()));
    const address = fakeServer.address();
    fakePort = typeof address === "object" && address ? address.port : 0;

    server = await startServer({
      token: TOKEN,
      tunnelUrl: `http://127.0.0.1:${fakePort}`,
      tunnelStubPath: path.join(workDir, "tunnel-stub.cjs"),
      tunnel: {
        cloudflaredPath: process.execPath,
        configPath: path.join(workDir, "config.yml"),
        autoRestart: false,
      },
    });
    writeFileSync(path.join(workDir, "config.yml"), "tunnel: stub\n", "utf8");
  }, 30_000);

  afterAll(async () => {
    // detached 的 stub 不会随测试进程退出，必须显式停掉
    await postTunnel(server, "stop").catch(() => undefined);
    await server?.stop();
    if (fakeServer.listening) {
      await new Promise<void>((resolve) => fakeServer.close(() => resolve()));
    }
    rmSync(workDir, { recursive: true, force: true });
  });

  it("/health 无鉴权返回 200，/mcp 仍要令牌", async () => {
    const health = await fetch(`http://127.0.0.1:${server.port}/health`);
    expect(health.status).toBe(200);
    const body = (await health.json()) as { ok: boolean; service: string };
    expect(body.ok).toBe(true);
    expect(body.service).toBe("nexus-mcp");

    const mcp = await fetch(`http://127.0.0.1:${server.port}/mcp`, { method: "POST" });
    expect(mcp.status).toBe(401);
  });

  it("页面有隧道卡与启动/停止/检测按钮", async () => {
    const response = await fetch(server.panelUrl);
    const html = await response.text();
    expect(html).toContain('data-block="tunnel"');
    expect(html).toContain('id="tunnel-start"');
    expect(html).toContain('id="tunnel-stop"');
    expect(html).toContain('id="tunnel-probe"');
    expect(html).toContain("检测可达性");
  });

  it("初始状态：进程未运行，状态灯红，带公网地址", async () => {
    const status = await getStatus(server);
    expect(status.tunnel.url).toBe(`http://127.0.0.1:${fakePort}`);
    expect(status.tunnel.process?.running).toBe(false);
    expect(status.tunnel.state).toBe("down");
    expect(status.tunnel.label).toBe("离线");
    expect(status.tunnel.detail).toContain("未运行");
  });

  it(
    "面板启动隧道：managed 进程跑起来，公网可达变绿",
    async () => {
      const response = await postTunnel(server, "start");
      expect(response.status).toBe(200);
      const started = (await response.json()) as StatusBody;
      expect(started.tunnel.process?.running).toBe(true);
      expect(started.tunnel.process?.managed).toBe(true);
      expect(started.tunnel.process?.pid).toBeGreaterThan(0);

      // stub 写日志有延迟，轮询等尾部出现，顺带等公网探测变绿
      await waitFor(async () => {
        const status = await getStatus(server);
        return (
          (status.tunnel.process?.tail ?? []).join("\n").includes("stub: tunnel started") &&
          status.tunnel.state === "up"
        );
      });
      const status = await getStatus(server);
      expect(status.tunnel.state).toBe("up");
      expect(status.tunnel.detail).toContain("公网可达");
    },
    15_000,
  );

  it("检测可达性：fake 隧道断开后，进程仍在但公网不通", async () => {
    await new Promise<void>((resolve) => fakeServer.close(() => resolve()));

    const response = await postTunnel(server, "probe");
    expect(response.status).toBe(200);
    const status = (await response.json()) as StatusBody;
    expect(status.tunnel.process?.running).toBe(true);
    expect(status.tunnel.state).toBe("down");
    expect(status.tunnel.detail).toContain("公网不通");
  });

  it("面板停止隧道：进程退出，不再重启", async () => {
    const response = await postTunnel(server, "stop");
    expect(response.status).toBe(200);
    const status = (await response.json()) as StatusBody;
    expect(status.tunnel.process?.running).toBe(false);
    expect(status.tunnel.state).toBe("down");

    const later = await getStatus(server);
    expect(later.tunnel.process?.running).toBe(false);
  });

  it("隧道接口拒绝跨站写操作", async () => {
    const response = await postTunnel(server, "start", { Origin: "https://evil.example" });
    expect(response.status).toBe(403);
  });
});
