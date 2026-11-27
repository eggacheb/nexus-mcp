import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

  it("自动重启触发时若外部进程已接管或配置缺失，autoRestarting 归零不卡死", async () => {
    const flagFile = path.join(workDir, "exit-flag-stuck");
    writeFileSync(flagFile, "7", "utf8");
    process.env.NEXUS_STUB_EXIT_FILE = flagFile;
    let external = false;
    try {
      const opts = stubOptions(workDir, {
        autoRestart: true,
        restartDelayMs: 150,
        isRunningExternal: async () => external,
      });
      const manager = new TunnelManager(opts);
      await manager.start();
      await waitFor(() => manager.status().then((s) => s.autoRestarting === true));

      // 外部隧道在倒计时期间拉起：到点触发 start() 早退后，autoRestarting 必须清回 false
      external = true;
      await waitFor(() => manager.status().then((s) => s.autoRestarting === false), 3_000);
      expect((await manager.status()).running).toBe(true);

      // 再次验证配置缺失导致自动重启抛错时，autoRestarting 同样清回 false
      external = false;
      const missingDir = mkdtempSync(path.join(os.tmpdir(), "nexus-tunnel-missing-"));
      try {
        const opts2 = stubOptions(missingDir, {
          autoRestart: true,
          restartDelayMs: 150,
          isRunningExternal: async () => false,
        });
        writeFileSync(path.join(missingDir, "tunnel-stub.cjs"), STUB_SOURCE, "utf8");
        const manager2 = new TunnelManager(opts2);
        await manager2.start();
        await waitFor(() => manager2.status().then((s) => s.autoRestarting === true));
        rmSync(opts2.configPath, { force: true });
        await waitFor(() => manager2.status().then((s) => s.autoRestarting === false), 3_000);
      } finally {
        rmSync(missingDir, { recursive: true, force: true });
      }
    } finally {
      delete process.env.NEXUS_STUB_EXIT_FILE;
    }
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
        autoStart: false,
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
    "面板启动隧道：managed 进程跑起来，状态跟着进程走",
    async () => {
      const response = await postTunnel(server, "start");
      expect(response.status).toBe(200);
      const started = (await response.json()) as StatusBody;
      expect(started.tunnel.process?.running).toBe(true);
      expect(started.tunnel.process?.managed).toBe(true);
      expect(started.tunnel.process?.pid).toBeGreaterThan(0);

      // stub 写日志有延迟，轮询等尾部出现
      await waitFor(async () => {
        const status = await getStatus(server);
        return (status.tunnel.process?.tail ?? []).join("\n").includes("stub: tunnel started");
      });
      // metrics 端口在测试里钉到 1（没人监听）：进程在跑但验不了边缘 → 黄灯运行中，不报红
      const status = await getStatus(server);
      expect(status.tunnel.state).toBe("connecting");
      expect(status.tunnel.label).toBe("运行中");
      expect(status.tunnel.detail).toContain("未验证边缘连接");
    },
    15_000,
  );

  it("检测可达性：fake 隧道断开后只影响手动探测结果，状态灯不翻红", async () => {
    await new Promise<void>((resolve) => fakeServer.close(() => resolve()));

    const response = await postTunnel(server, "probe");
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      probe: { ok: boolean; status?: number; error?: string; ms?: number };
    };
    expect(body.probe.ok).toBe(false);
    expect(body.probe.error ?? "").toBeTruthy();
    expect(body.probe.ms).toBeGreaterThanOrEqual(0);

    // 关键：公网断了，但进程还在跑，灯不该被打成红
    const status = await getStatus(server);
    expect(status.tunnel.process?.running).toBe(true);
    expect(status.tunnel.state).toBe("connecting");
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

  it(
    "受管隧道运行中重载修改或删除 tunnel 配置时，旧子进程同步重启或回收不留孤儿",
    async () => {
      const isPidAlive = (pid: number): boolean => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      };
      const postService = (action: string) =>
        fetch(`${server.panelUrl}/api/service`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Origin: server.panelUrl,
          },
          body: JSON.stringify({ action }),
        });

      const originalConfig = readFileSync(server.configPath, "utf8");
      try {
        const started = await postTunnel(server, "start");
        expect(started.status).toBe(200);
        const startedBody = (await started.json()) as StatusBody;
        const firstPid = startedBody.tunnel.process?.pid ?? 0;
        expect(firstPid).toBeGreaterThan(0);
        expect(isPidAlive(firstPid)).toBe(true);

        // 1) 修改 tunnel.configPath 后重载：旧受管子进程应重启切换到新配置
        const configV2 = path.join(workDir, "config-v2.yml");
        writeFileSync(configV2, "tunnel: stub-v2\n", "utf8");
        const parsed = JSON.parse(originalConfig) as Record<string, unknown>;
        writeFileSync(
          server.configPath,
          JSON.stringify(
            {
              ...parsed,
              tunnel: {
                ...(parsed.tunnel as Record<string, unknown>),
                configPath: configV2,
              },
            },
            null,
            2,
          ),
          "utf8",
        );

        const reloaded = await postService("reload");
        expect(reloaded.status).toBe(200);
        await waitFor(() => !isPidAlive(firstPid), 5_000);
        const afterModify = await getStatus(server);
        const secondPid = afterModify.tunnel.process?.pid ?? 0;
        expect(afterModify.tunnel.process?.running).toBe(true);
        expect(afterModify.tunnel.process?.managed).toBe(true);
        expect(secondPid).toBeGreaterThan(0);
        expect(secondPid).not.toBe(firstPid);

        // 2) 删除 tunnel 段后重载：面板自拉起的受管子进程应同步停掉，不遗留失控进程
        const withoutTunnel = { ...parsed };
        delete withoutTunnel.tunnel;
        writeFileSync(server.configPath, JSON.stringify(withoutTunnel, null, 2), "utf8");
        const cleared = await postService("reload");
        expect(cleared.status).toBe(200);
        await waitFor(() => !isPidAlive(secondPid), 5_000);
        const afterClear = await getStatus(server);
        expect(afterClear.tunnel.state).toBe("unconfigured");
      } finally {
        writeFileSync(server.configPath, originalConfig, "utf8");
        await postService("reload");
      }
    },
    25_000,
  );
});

describe("隧道随服务自启与协议层优雅全停入口", () => {
  const isPidAlive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  it(
    "tunnel.autoStart 默认开启：服务启动后自动拉起隧道；POST /api/shutdown(includeTunnel=true) 同步停隧道且不触发守护拉回",
    async () => {
      const workDir = mkdtempSync(path.join(os.tmpdir(), "nexus-mcp-autostart-"));
      const stubPath = path.join(workDir, "tunnel-stub.cjs");
      const cfgPath = path.join(workDir, "config.yml");
      writeFileSync(stubPath, STUB_SOURCE, "utf8");
      writeFileSync(cfgPath, "tunnel: stub\n", "utf8");

      let tunnelPid = 0;
      const server = await startServer({
        token: TOKEN,
        tunnelStubPath: stubPath,
        tunnel: {
          cloudflaredPath: process.execPath,
          configPath: cfgPath,
          autoRestart: true,
        },
      });
      try {
        // 1) 未显式传 autoStart，默认应自动拉起隧道
        await waitFor(async () => {
          const status = await getStatus(server);
          if (status.tunnel.process?.running && status.tunnel.process.pid) {
            tunnelPid = status.tunnel.process.pid;
            return true;
          }
          return false;
        }, 8_000);
        expect(tunnelPid).toBeGreaterThan(0);
        expect(isPidAlive(tunnelPid)).toBe(true);

        // 2) 跨站 Origin 应被 /api/shutdown 拒绝
        const denied = await fetch(`${server.panelUrl}/api/shutdown`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Origin: "https://evil.example",
          },
          body: JSON.stringify({ includeTunnel: true }),
        });
        expect(denied.status).toBe(403);

        // 3) 合法本机请求触发彻底退出（includeTunnel=true）：停隧道且停协议层
        const res = await fetch(`${server.panelUrl}/api/shutdown`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ includeTunnel: true }),
        });
        expect(res.status).toBe(200);

        await waitFor(() => !isPidAlive(tunnelPid), 6_000);
        // 端口也应释放（服务已退出）
        await waitFor(async () => {
          try {
            await fetch(`http://127.0.0.1:${server.port}/health`);
            return false;
          } catch {
            return true;
          }
        }, 6_000);
      } finally {
        if (tunnelPid > 0 && isPidAlive(tunnelPid)) {
          try {
            process.kill(tunnelPid);
          } catch {
            // ignore
          }
        }
        await server.stop().catch(() => undefined);
        rmSync(workDir, { recursive: true, force: true });
      }
    },
    25_000,
  );

  it(
    "tunnel.autoStart=false 时不自启；POST /api/shutdown(includeTunnel=false) 停协议层但保留隧道存活",
    async () => {
      const workDir = mkdtempSync(path.join(os.tmpdir(), "nexus-mcp-keep-tunnel-"));
      const stubPath = path.join(workDir, "tunnel-stub.cjs");
      const cfgPath = path.join(workDir, "config.yml");
      writeFileSync(stubPath, STUB_SOURCE, "utf8");
      writeFileSync(cfgPath, "tunnel: stub\n", "utf8");

      let tunnelPid = 0;
      const server = await startServer({
        token: TOKEN,
        tunnelStubPath: stubPath,
        tunnel: {
          cloudflaredPath: process.execPath,
          configPath: cfgPath,
          autoStart: false,
          autoRestart: false,
        },
      });
      try {
        const initial = await getStatus(server);
        expect(initial.tunnel.process?.running).toBe(false);

        // 手动启动隧道
        const startRes = await postTunnel(server, "start");
        expect(startRes.status).toBe(200);
        const started = (await startRes.json()) as StatusBody;
        tunnelPid = started.tunnel.process?.pid ?? 0;
        expect(tunnelPid).toBeGreaterThan(0);
        expect(isPidAlive(tunnelPid)).toBe(true);

        // includeTunnel=false 关停：服务退出，但隧道继续存活
        const shutdownRes = await fetch(`${server.panelUrl}/api/shutdown`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ includeTunnel: false }),
        });
        expect(shutdownRes.status).toBe(200);

        await waitFor(async () => {
          try {
            await fetch(`http://127.0.0.1:${server.port}/health`);
            return false;
          } catch {
            return true;
          }
        }, 6_000);
        expect(isPidAlive(tunnelPid)).toBe(true);
      } finally {
        if (tunnelPid > 0 && isPidAlive(tunnelPid)) {
          try {
            process.kill(tunnelPid);
          } catch {
            // ignore
          }
        }
        await server.stop().catch(() => undefined);
        rmSync(workDir, { recursive: true, force: true });
      }
    },
    25_000,
  );
});

describe("临时隧道与单通道模式", () => {
  const QUICK_STUB_SOURCE = `
const args = process.argv.slice(2);
const urlIdx = args.indexOf("--url");
const target = urlIdx >= 0 ? args[urlIdx + 1] : "";
console.error("INF +--------------------------------------------------------------------------------------------+");
console.error("INF |  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):  |");
console.error("INF |  https://demo-quick-test.trycloudflare.com                                                 |");
console.error("INF +--------------------------------------------------------------------------------------------+");
console.error("INF target=" + target);
setInterval(() => {}, 1000);
`;

  function startMockDownloadServer(payload: Buffer): Promise<{ url: string; close(): Promise<void> }> {
    return new Promise((resolve, reject) => {
      const srv = http.createServer((_req, res) => {
        res.writeHead(200, { "Content-Type": "application/octet-stream" });
        res.end(payload);
      });
      srv.once("error", reject);
      srv.listen(0, "127.0.0.1", () => {
        const addr = srv.address();
        const port = typeof addr === "object" && addr ? addr.port : 0;
        resolve({
          url: `http://127.0.0.1:${port}/cloudflared.exe`,
          close: () =>
            new Promise<void>((done) => {
              srv.close(() => done());
              srv.closeAllConnections();
            }),
        });
      });
    });
  }

  function isPidAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  it("未配置 tunnel 段时默认 tunnelMode=none，已有 tunnel 段时向后兼容推导为 named", async () => {
    const serverNone = await startServer({ token: TOKEN });
    try {
      const statusNone = (await (await fetch(`${serverNone.panelUrl}/api/status`)).json()) as {
        tunnel: { mode?: string; state: string };
      };
      expect(statusNone.tunnel.mode).toBe("none");
      expect(statusNone.tunnel.state).toBe("unconfigured");
    } finally {
      await serverNone.stop();
    }

    const workDir = mkdtempSync(path.join(os.tmpdir(), "nexus-mode-named-"));
    const cfgPath = path.join(workDir, "config.yml");
    writeFileSync(cfgPath, "tunnel: stub\n", "utf8");
    const serverNamed = await startServer({
      token: TOKEN,
      tunnelUrl: "https://fixed.example.com",
      tunnel: {
        cloudflaredPath: process.execPath,
        configPath: cfgPath,
        autoStart: false,
        autoRestart: false,
      },
    });
    try {
      const statusNamed = (await (await fetch(`${serverNamed.panelUrl}/api/status`)).json()) as {
        tunnel: { mode?: string; url?: string };
      };
      expect(statusNamed.tunnel.mode).toBe("named");
      expect(statusNamed.tunnel.url).toBe("https://fixed.example.com");
    } finally {
      await serverNamed.stop();
      rmSync(workDir, { recursive: true, force: true });
    }
  }, 20_000);

  it("按需下载 cloudflared：SHA-256 不符时拒绝且不留脏文件，匹配时缓存并拉起临时隧道回填连接信息", async () => {
    const workDir = mkdtempSync(path.join(os.tmpdir(), "nexus-quick-dl-"));
    const cacheDir = path.join(workDir, "bin");
    const stubPath = path.join(workDir, "quick-stub.cjs");
    writeFileSync(stubPath, QUICK_STUB_SOURCE, "utf8");

    const fakePayload = Buffer.from("fake-cloudflared-binary-payload-v1");
    const goodSha = createHash("sha256").update(fakePayload).digest("hex");
    const badSha = "0".repeat(64);
    const mockDl = await startMockDownloadServer(fakePayload);

    // 1. 哈希不符：拒绝且缓存目录无文件
    const badServer = await startServer({
      token: TOKEN,
      env: {
        NEXUS_CLOUDFLARED_SKIP_SYSTEM: "1",
        NEXUS_CLOUDFLARED_CACHE_DIR: cacheDir,
        NEXUS_CLOUDFLARED_DOWNLOAD_URL: mockDl.url,
        NEXUS_CLOUDFLARED_SHA256: badSha,
        NEXUS_QUICK_TUNNEL_STUB: stubPath,
      },
    });
    try {
      const res = await fetch(`${badServer.panelUrl}/api/tunnel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "mode", mode: "quick" }),
      });
      expect(res.status).toBe(500);
      const body = (await res.json()) as { error?: string };
      expect(body.error).toContain("校验和");
      expect(existsSync(path.join(cacheDir, "cloudflared.exe"))).toBe(false);
    } finally {
      await badServer.stop();
    }

    // 2. 哈希匹配：下载缓存并拉起临时隧道，回填 status 与 credentials
    const okServer = await startServer({
      token: TOKEN,
      env: {
        NEXUS_CLOUDFLARED_SKIP_SYSTEM: "1",
        NEXUS_CLOUDFLARED_CACHE_DIR: cacheDir,
        NEXUS_CLOUDFLARED_DOWNLOAD_URL: mockDl.url,
        NEXUS_CLOUDFLARED_SHA256: goodSha,
        NEXUS_QUICK_TUNNEL_STUB: stubPath,
      },
    });
    let quickPid = 0;
    try {
      const res = await fetch(`${okServer.panelUrl}/api/tunnel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "mode", mode: "quick" }),
      });
      expect(res.status).toBe(200);
      expect(existsSync(path.join(cacheDir, "cloudflared.exe"))).toBe(true);

      const status = (await res.json()) as {
        tunnel: {
          mode: string;
          state: string;
          url?: string;
          ephemeral?: boolean;
          quick?: { running: boolean; pid?: number; url?: string };
        };
      };
      expect(status.tunnel.mode).toBe("quick");
      expect(status.tunnel.state).toBe("up");
      expect(status.tunnel.ephemeral).toBe(true);
      expect(status.tunnel.url).toBe("https://demo-quick-test.trycloudflare.com");
      quickPid = status.tunnel.quick?.pid ?? 0;
      expect(quickPid).toBeGreaterThan(0);

      const creds = (await (await fetch(`${okServer.panelUrl}/api/credentials`)).json()) as {
        publicUrl: string;
        tunnelMode?: string;
        ephemeral?: boolean;
      };
      expect(creds.publicUrl).toBe("https://demo-quick-test.trycloudflare.com/mcp");
      expect(creds.tunnelMode).toBe("quick");
      expect(creds.ephemeral).toBe(true);

      // includeTunnel=true 退出时清理临时隧道进程，不留孤儿
      const shutdownRes = await fetch(`${okServer.panelUrl}/api/shutdown`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ includeTunnel: true }),
      });
      expect(shutdownRes.status).toBe(200);
      await waitFor(() => !isPidAlive(quickPid), 6_000);
    } finally {
      if (quickPid > 0 && isPidAlive(quickPid)) {
        try {
          process.kill(quickPid);
        } catch {
          // ignore
        }
      }
      await okServer.stop().catch(() => undefined);
      await mockDl.close();
      rmSync(workDir, { recursive: true, force: true });
    }
  }, 25_000);

  it("命名隧道切到临时隧道再切回命名隧道：先停旧渠道且不丢失原有固定 tunnelUrl", async () => {
    const workDir = mkdtempSync(path.join(os.tmpdir(), "nexus-mode-switch-"));
    const namedStubPath = path.join(workDir, "named-stub.cjs");
    const quickStubPath = path.join(workDir, "quick-stub.cjs");
    const cfgPath = path.join(workDir, "config.yml");
    writeFileSync(namedStubPath, STUB_SOURCE, "utf8");
    writeFileSync(quickStubPath, QUICK_STUB_SOURCE, "utf8");
    writeFileSync(cfgPath, "tunnel: stub\n", "utf8");

    const server = await startServer({
      token: TOKEN,
      tunnelUrl: "https://fixed.example.com",
      tunnelStubPath: namedStubPath,
      tunnel: {
        cloudflaredPath: process.execPath,
        configPath: cfgPath,
        autoStart: true,
        autoRestart: false,
      },
      env: {
        NEXUS_QUICK_TUNNEL_STUB: quickStubPath,
        NEXUS_QUICK_TUNNEL_EXE: process.execPath,
      },
    });
    let quickPid = 0;
    try {
      const initial = (await (await fetch(`${server.panelUrl}/api/status`)).json()) as {
        tunnel: { mode: string; process?: { running: boolean; pid?: number } };
      };
      expect(initial.tunnel.mode).toBe("named");
      const namedPid = initial.tunnel.process?.pid ?? 0;
      expect(namedPid).toBeGreaterThan(0);

      // 切到临时隧道：旧命名隧道应被停止
      const toQuick = await fetch(`${server.panelUrl}/api/tunnel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "mode", mode: "quick" }),
      });
      expect(toQuick.status).toBe(200);
      const quickStatus = (await toQuick.json()) as {
        tunnel: { mode: string; url?: string; quick?: { pid?: number } };
      };
      expect(quickStatus.tunnel.mode).toBe("quick");
      expect(quickStatus.tunnel.url).toBe("https://demo-quick-test.trycloudflare.com");
      quickPid = quickStatus.tunnel.quick?.pid ?? 0;
      await waitFor(() => !isPidAlive(namedPid), 5_000);

      // 切回命名隧道：临时隧道停止，原有固定 tunnelUrl 完好无损
      const toNamed = await fetch(`${server.panelUrl}/api/tunnel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "mode", mode: "named" }),
      });
      expect(toNamed.status).toBe(200);
      const namedStatus = (await toNamed.json()) as {
        tunnel: { mode: string; url?: string };
      };
      expect(namedStatus.tunnel.mode).toBe("named");
      expect(namedStatus.tunnel.url).toBe("https://fixed.example.com");
      await waitFor(() => !isPidAlive(quickPid), 5_000);

      const saved = JSON.parse(readFileSync(server.configPath, "utf8")) as {
        tunnelMode?: string;
        tunnelUrl?: string;
      };
      expect(saved.tunnelMode).toBe("named");
      expect(saved.tunnelUrl).toBe("https://fixed.example.com");
    } finally {
      if (quickPid > 0 && isPidAlive(quickPid)) {
        try {
          process.kill(quickPid);
        } catch {
          // ignore
        }
      }
      await server.stop().catch(() => undefined);
      rmSync(workDir, { recursive: true, force: true });
    }
  }, 25_000);
});

describe("Tailscale Funnel 与四态单通道互斥", () => {
  const TAILSCALE_STUB_SOURCE = `
const fs = require("fs");
const args = process.argv.slice(2);
const logFile = process.env.NEXUS_TS_LOG_FILE;
const stateFile = process.env.NEXUS_TS_STATE_FILE;
if (logFile) fs.appendFileSync(logFile, args.join(" ") + "\\n");

function readState() {
  if (!stateFile || !fs.existsSync(stateFile)) return { loggedIn: true, needApproval: false, activePort: null };
  return JSON.parse(fs.readFileSync(stateFile, "utf8"));
}
function writeState(next) {
  if (stateFile) fs.writeFileSync(stateFile, JSON.stringify(next));
}

const st = readState();
if (args[0] === "status" && args.includes("--json")) {
  if (!st.loggedIn) {
    console.log(JSON.stringify({ BackendState: "NeedsLogin", Self: { DNSName: "" } }));
  } else {
    console.log(JSON.stringify({ BackendState: "Running", Self: { DNSName: "my-pc.tail1234.ts.net." } }));
  }
  process.exit(0);
}
if (args[0] === "funnel" && args[1] === "status") {
  if (st.activePort) {
    console.log(JSON.stringify({
      AllowFunnel: { "my-pc.tail1234.ts.net:443": true },
      Web: { "my-pc.tail1234.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:" + st.activePort } } } }
    }));
  } else {
    console.log(JSON.stringify({}));
  }
  process.exit(0);
}
if (args[0] === "funnel" && args.includes("--bg")) {
  if (st.needApproval) {
    console.error("Funnel is not enabled on your tailnet.");
    console.error("To enable, visit: https://login.tailscale.com/f/funnel?node=n123456");
    process.exit(1);
  }
  const port = args[args.length - 1];
  st.activePort = Number(port) || 8787;
  writeState(st);
  console.log("Available on the internet: https://my-pc.tail1234.ts.net/");
  process.exit(0);
}
if (args[0] === "funnel" && args.includes("off")) {
  st.activePort = null;
  writeState(st);
  console.log("Funnel disabled");
  process.exit(0);
}
process.exit(0);
`;

  const QUICK_STUB_SOURCE = `
console.error("INF https://switch-quick.trycloudflare.com");
setInterval(() => {}, 1000);
`;

  function isPidAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  it("老用户已配命名隧道且本机已登录 Tailscale：默认保持 named，不自动启用或覆盖 tunnelUrl", async () => {
    const workDir = mkdtempSync(path.join(os.tmpdir(), "nexus-ts-compat-"));
    const tsStub = path.join(workDir, "ts-stub.cjs");
    const tsLog = path.join(workDir, "ts.log");
    const tsState = path.join(workDir, "ts-state.json");
    const cfgPath = path.join(workDir, "config.yml");
    writeFileSync(tsStub, TAILSCALE_STUB_SOURCE, "utf8");
    writeFileSync(tsState, JSON.stringify({ loggedIn: true, needApproval: false, activePort: null }), "utf8");
    writeFileSync(cfgPath, "tunnel: stub\n", "utf8");

    const server = await startServer({
      token: TOKEN,
      tunnelUrl: "https://cf-fixed.example.com",
      tunnel: {
        cloudflaredPath: process.execPath,
        configPath: cfgPath,
        autoStart: false,
        autoRestart: false,
      },
      env: {
        NEXUS_TAILSCALE_STUB: tsStub,
        NEXUS_TS_LOG_FILE: tsLog,
        NEXUS_TS_STATE_FILE: tsState,
      },
    });
    try {
      const status = (await (await fetch(`${server.panelUrl}/api/status`)).json()) as {
        tunnel: { mode: string; url?: string };
      };
      expect(status.tunnel.mode).toBe("named");
      expect(status.tunnel.url).toBe("https://cf-fixed.example.com");
      expect(existsSync(tsLog)).toBe(false);
    } finally {
      await server.stop();
      rmSync(workDir, { recursive: true, force: true });
    }
  }, 20_000);

  it("Tailscale Funnel 首次授权链接引导、一键开启回填，以及与临时隧道的单通道互斥切换", async () => {
    const workDir = mkdtempSync(path.join(os.tmpdir(), "nexus-ts-switch-"));
    const tsStub = path.join(workDir, "ts-stub.cjs");
    const tsLog = path.join(workDir, "ts.log");
    const tsState = path.join(workDir, "ts-state.json");
    const quickStub = path.join(workDir, "quick-stub.cjs");
    writeFileSync(tsStub, TAILSCALE_STUB_SOURCE, "utf8");
    writeFileSync(tsState, JSON.stringify({ loggedIn: true, needApproval: true, activePort: null }), "utf8");
    writeFileSync(quickStub, QUICK_STUB_SOURCE, "utf8");

    const server = await startServer({
      token: TOKEN,
      tunnelUrl: "https://cf-fixed.example.com",
      env: {
        NEXUS_TAILSCALE_STUB: tsStub,
        NEXUS_TS_LOG_FILE: tsLog,
        NEXUS_TS_STATE_FILE: tsState,
        NEXUS_QUICK_TUNNEL_STUB: quickStub,
        NEXUS_QUICK_TUNNEL_EXE: process.execPath,
      },
    });
    let quickPid = 0;
    try {
      // 1. 首次开启触发授权链接引导
      const firstRes = await fetch(`${server.panelUrl}/api/tunnel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "mode", mode: "tailscale" }),
      });
      expect(firstRes.status).toBe(200);
      const firstBody = (await firstRes.json()) as {
        tunnel: { mode: string; state: string; tailscale?: { approvalUrl?: string } };
      };
      expect(firstBody.tunnel.mode).toBe("tailscale");
      expect(firstBody.tunnel.state).toBe("connecting");
      expect(firstBody.tunnel.tailscale?.approvalUrl).toBe("https://login.tailscale.com/f/funnel?node=n123456");

      // 2. 模拟用户在后台点完授权后再点一键开启
      writeFileSync(tsState, JSON.stringify({ loggedIn: true, needApproval: false, activePort: null }), "utf8");
      const enableRes = await fetch(`${server.panelUrl}/api/tunnel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "start" }),
      });
      expect(enableRes.status).toBe(200);
      const enabledBody = (await enableRes.json()) as {
        tunnel: { mode: string; state: string; url?: string };
      };
      expect(enabledBody.tunnel.state).toBe("up");
      expect(enabledBody.tunnel.url).toBe("https://my-pc.tail1234.ts.net");

      const creds = (await (await fetch(`${server.panelUrl}/api/credentials`)).json()) as {
        publicUrl: string;
        tunnelMode: string;
      };
      expect(creds.publicUrl).toBe("https://my-pc.tail1234.ts.net/mcp");
      expect(creds.tunnelMode).toBe("tailscale");

      // config.json 原有 tunnelUrl 未被覆盖
      const saved = JSON.parse(readFileSync(server.configPath, "utf8")) as {
        tunnelUrl?: string;
        tailscaleUrl?: string;
      };
      expect(saved.tunnelUrl).toBe("https://cf-fixed.example.com");
      expect(saved.tailscaleUrl).toBe("https://my-pc.tail1234.ts.net");

      // 3. 从 tailscale 切换到 quick：必须先执行 tailscale funnel --https=443 off
      const toQuick = await fetch(`${server.panelUrl}/api/tunnel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "mode", mode: "quick" }),
      });
      expect(toQuick.status).toBe(200);
      const quickBody = (await toQuick.json()) as {
        tunnel: { mode: string; url?: string; quick?: { pid?: number } };
      };
      expect(quickBody.tunnel.mode).toBe("quick");
      expect(quickBody.tunnel.url).toBe("https://switch-quick.trycloudflare.com");
      quickPid = quickBody.tunnel.quick?.pid ?? 0;
      expect(quickPid).toBeGreaterThan(0);
      const logText = readFileSync(tsLog, "utf8");
      expect(logText).toContain("funnel --https=443 off");

      // 4. 从 quick 切回 tailscale：临时隧道进程必须退出
      const backToTs = await fetch(`${server.panelUrl}/api/tunnel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "mode", mode: "tailscale" }),
      });
      expect(backToTs.status).toBe(200);
      await waitFor(() => !isPidAlive(quickPid), 5_000);
    } finally {
      if (quickPid > 0 && isPidAlive(quickPid)) {
        try {
          process.kill(quickPid);
        } catch {
          // ignore
        }
      }
      await server.stop().catch(() => undefined);
      rmSync(workDir, { recursive: true, force: true });
    }
  }, 25_000);
});
