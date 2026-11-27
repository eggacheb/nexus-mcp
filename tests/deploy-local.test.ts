import { execFileSync, execSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { freePort, projectRoot } from "./support/server.js";

const deployScript = path.join(projectRoot, "scripts", "deploy-local.mjs");
const stageDir = path.join(projectRoot, "build", "package");

async function waitFor(predicate: () => Promise<boolean> | boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 120));
  }
  throw new Error(`waitFor 超时 (${timeoutMs}ms)`);
}

async function stopTrayViaControl(targetDir: string): Promise<void> {
  const ctrlFile = path.join(targetDir, ".tray-control.json");
  if (!existsSync(ctrlFile)) return;
  try {
    const ctrl = JSON.parse(readFileSync(ctrlFile, "utf8")) as {
      port: number;
      pid: number;
      token: string;
    };
    await fetch(`http://127.0.0.1:${ctrl.port}/quit`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Tray-Token": ctrl.token,
      },
      body: JSON.stringify({ includeTunnel: true }),
    }).catch(() => undefined);
    await waitFor(() => {
      try {
        process.kill(ctrl.pid, 0);
        return false;
      } catch {
        return true;
      }
    }, 5_000).catch(() => undefined);
  } catch {
    // ignore
  }
}

describe("票 06: 本地一键热切换部署脚本（缝隙 3）", () => {
  const tempDirs: string[] = [];

  beforeAll(() => {
    const missing = ["nexus-mcp.exe", "nexus-server.exe", "nexus-executor.exe"].some(
      (name) => !existsSync(path.join(stageDir, name)),
    );
    if (missing) {
      // 只做 stage 打包，绝不在 vitest 并发期间重跑 tsc 覆写 dist/（否则会打断其他并发读取 dist/ 的测试）
      execFileSync(
        process.execPath,
        [
          path.join(projectRoot, "node_modules", "tsx", "dist", "cli.mjs"),
          path.join(projectRoot, "scripts", "package.ts"),
          "--stage-only",
        ],
        { cwd: projectRoot, stdio: "inherit" },
      );
    }
  }, 120_000);

  afterAll(async () => {
    for (const dir of tempDirs) {
      await stopTrayViaControl(dir);
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 15, retryDelay: 200 });
      } catch {
        // Windows 句柄延迟释放时忽略临时目录清理警告
      }
    }
  });

  it(
    "独立运行目录：首次脱离进程树部署 -> 同哈希走托盘内换核 -> 坏托盘包触发 10 秒内自动回滚，config/oauth 零改动",
    async () => {
      // 依赖 build/package 三件套（由 package:stage 生成）；未构建时先明确提示
      for (const name of ["nexus-mcp.exe", "nexus-server.exe", "nexus-executor.exe"]) {
        expect(existsSync(path.join(stageDir, name))).toBe(true);
      }

      const workDir = mkdtempSync(path.join(os.tmpdir(), "nexus-deploy-e2e-"));
      tempDirs.push(workDir);
      const targetDir = path.join(workDir, "runtime");
      const badStageDir = path.join(workDir, "bad-stage");
      mkdirSync(targetDir, { recursive: true });
      mkdirSync(badStageDir, { recursive: true });

      const mcpPort = await freePort();
      const panelPort = await freePort();
      const configContent = JSON.stringify(
        {
          root: targetDir,
          transport: "http",
          port: mcpPort,
          panelPort,
          token: "deploy-keep-token-1234",
          shell: "auto",
        },
        null,
        2,
      );
      const oauthContent = JSON.stringify({ clients: { keep: "oauth-v1" } }, null, 2);
      writeFileSync(path.join(targetDir, "config.json"), configContent, "utf8");
      writeFileSync(path.join(targetDir, "oauth-store.json"), oauthContent, "utf8");

      const mutexName = `Local\\nexus-deploy-e2e-${process.pid}-${mcpPort}`;
      const sharedEnv: Record<string, string | undefined> = {
        ...process.env,
        NEXUS_MCP_CONFIG: path.join(targetDir, "config.json"),
        NEXUS_MCP_LOG_DIR: undefined,
        NEXUS_MCP_PORT: undefined,
        NEXUS_MCP_ROOT: undefined,
        NEXUS_MCP_TOKEN: undefined,
        NEXUS_TRAY_HEADLESS: "detached",
        NEXUS_TRAY_MUTEX: mutexName,
        NEXUS_TRAY_NO_BROWSER: "1",
        NEXUS_TUNNEL_EXTERNAL: "off",
      };

      // 1) 首次部署（目标目录无旧托盘，trayChanged=true -> detached-worker 路径）
      const out1 = execFileSync(
        process.execPath,
        [
          deployScript,
          "--skip-build",
          "--skip-smoke",
          "--target",
          targetDir,
          "--stage-dir",
          stageDir,
          "--delay-ms",
          "200",
          "--health-timeout-ms",
          "10000",
        ],
        { cwd: projectRoot, env: sharedEnv, encoding: "utf8" },
      );
      const res1 = JSON.parse(out1.trim()) as { ok: boolean; mode: string; logPath: string };
      expect(res1.ok).toBe(true);
      expect(res1.mode).toBe("detached-worker");

      await waitFor(async () => {
        try {
          const r = await fetch(`http://127.0.0.1:${mcpPort}/health`);
          return r.status === 200;
        } catch {
          return false;
        }
      }, 15_000);
      await waitFor(() => {
        const ctrlFile = path.join(targetDir, ".tray-control.json");
        if (!existsSync(ctrlFile)) return false;
        try {
          const parsed = JSON.parse(readFileSync(ctrlFile, "utf8")) as { port?: number; token?: string };
          return typeof parsed.port === "number" && parsed.port > 0 && Boolean(parsed.token);
        } catch {
          return false;
        }
      }, 10_000);

      // 2) 再次部署相同托盘哈希 -> 命中托盘内无缝换核（mode: "in-place"）
      const out2 = execFileSync(
        process.execPath,
        [
          deployScript,
          "--skip-build",
          "--skip-smoke",
          "--target",
          targetDir,
          "--stage-dir",
          stageDir,
          "--delay-ms",
          "200",
          "--health-timeout-ms",
          "10000",
        ],
        { cwd: projectRoot, env: sharedEnv, encoding: "utf8" },
      );
      const res2 = JSON.parse(out2.trim()) as { ok: boolean; mode: string; logPath: string };
      expect(res2.ok).toBe(true);
      expect(res2.mode).toBe("in-place");

      await waitFor(() => {
        const logFile = path.join(targetDir, "logs", "hotswap.log");
        return existsSync(logFile) && readFileSync(logFile, "utf8").includes("hotswap.success");
      }, 15_000);

      const lastOkPath = path.join(targetDir, "logs", "last-hotswap.json");
      expect(existsSync(lastOkPath)).toBe(true);
      const lastOk = JSON.parse(readFileSync(lastOkPath, "utf8")) as { status: string; mode: string };
      expect(lastOk.status).toBe("ok");

      // 3) 投喂崩溃托盘包（借用已构建的 crash-helper.exe 冒充坏 nexus-mcp.exe -> 哈希不同走 detached-worker 并触发回滚）
      const crashHelper = path.join(projectRoot, "crates", "target", "release", "crash-helper.exe");
      expect(existsSync(crashHelper)).toBe(true);
      copyFileSync(crashHelper, path.join(badStageDir, "nexus-mcp.exe"));
      copyFileSync(path.join(stageDir, "nexus-server.exe"), path.join(badStageDir, "nexus-server.exe"));
      copyFileSync(
        path.join(stageDir, "nexus-executor.exe"),
        path.join(badStageDir, "nexus-executor.exe"),
      );

      const out3 = execFileSync(
        process.execPath,
        [
          deployScript,
          "--skip-build",
          "--skip-smoke",
          "--target",
          targetDir,
          "--stage-dir",
          badStageDir,
          "--delay-ms",
          "200",
          "--health-timeout-ms",
          "2500",
        ],
        { cwd: projectRoot, env: sharedEnv, encoding: "utf8" },
      );
      const res3 = JSON.parse(out3.trim()) as {
        ok: boolean;
        mode: string;
        spawnedByTray: boolean;
        trayChanged: boolean;
        logPath: string;
      };
      expect(res3.ok).toBe(true);
      expect(res3.mode).toBe("detached-worker");
      expect(res3.spawnedByTray).toBe(true);
      expect(res3.trayChanged).toBe(true);

      await waitFor(() => {
        return existsSync(res3.logPath) && readFileSync(res3.logPath, "utf8").includes("worker.rollback_done");
      }, 35_000);

      const lastRbPath = path.join(targetDir, "logs", "last-hotswap.json");
      const lastRb = JSON.parse(readFileSync(lastRbPath, "utf8")) as { status: string; mode: string };
      expect(lastRb.status).toBe("rolled_back");
      expect(lastRb.mode).toBe("detached-worker");

      // 回滚后 /health 必须恢复 200
      await waitFor(async () => {
        try {
          const r = await fetch(`http://127.0.0.1:${mcpPort}/health`);
          return r.status === 200;
        } catch {
          return false;
        }
      }, 10_000);

      // 用户配置与 OAuth 存储全程字节级不变
      expect(readFileSync(path.join(targetDir, "config.json"), "utf8")).toBe(configContent);
      expect(readFileSync(path.join(targetDir, "oauth-store.json"), "utf8")).toBe(oauthContent);
    },
    60_000,
  );
});
