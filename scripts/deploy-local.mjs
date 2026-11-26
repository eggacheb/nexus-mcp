#!/usr/bin/env node
/**
 * 本地一键构建、冒烟并触发延迟热切换（不依赖 pnpm POSIX npm wrapper）。
 *
 * 用法：
 *   node scripts/deploy-local.mjs
 *   node scripts/deploy-local.mjs --target <dir> --stage-dir <dir> [--skip-build] [--skip-smoke]
 */
import { execFileSync, execSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
} from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const rootDir = path.resolve(path.dirname(__filename), "..");

const TRAY_EXE = "nexus-mcp.exe";
const SERVER_EXE = "nexus-server.exe";
const EXECUTOR_EXE = "nexus-executor.exe";
const CONTROL_FILE = ".tray-control.json";

function parseArgs(argv) {
  const opts = {
    worker: false,
    skipBuild: false,
    skipSmoke: false,
    targetDir:
      process.env.NEXUS_DEPLOY_TARGET?.trim() ||
      path.join(process.env.LOCALAPPDATA ?? "", "Programs", "nexus-mcp"),
    stageDir: path.join(rootDir, "build", "package"),
    delayMs: 1500,
    healthTimeoutMs: 10_000,
    logPath: "",
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--worker") opts.worker = true;
    else if (arg === "--skip-build") opts.skipBuild = true;
    else if (arg === "--skip-smoke") opts.skipSmoke = true;
    else if (arg === "--target" && argv[i + 1]) opts.targetDir = path.resolve(argv[++i]);
    else if (arg === "--stage-dir" && argv[i + 1]) opts.stageDir = path.resolve(argv[++i]);
    else if (arg === "--delay-ms" && argv[i + 1]) opts.delayMs = Number(argv[++i]);
    else if (arg === "--health-timeout-ms" && argv[i + 1]) opts.healthTimeoutMs = Number(argv[++i]);
    else if (arg === "--log-path" && argv[i + 1]) opts.logPath = path.resolve(argv[++i]);
  }
  if (!opts.logPath) {
    opts.logPath = path.join(opts.targetDir, "logs", "deploy-hotswap.log");
  }
  return opts;
}

function sha256File(filePath) {
  if (!existsSync(filePath)) return null;
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function appendLog(logPath, message) {
  mkdirSync(path.dirname(logPath), { recursive: true });
  appendFileSync(logPath, `[${new Date().toISOString()}] ${message}\n`, "utf8");
}

function readMcpPort(targetDir) {
  const envPort = Number(process.env.NEXUS_TRAY_MCP_PORT ?? "");
  if (Number.isInteger(envPort) && envPort > 0) return envPort;
  const cfgPath = path.join(targetDir, "config.json");
  if (!existsSync(cfgPath)) return 8787;
  try {
    const parsed = JSON.parse(readFileSync(cfgPath, "utf8"));
    const port = Number(parsed?.port);
    return Number.isInteger(port) && port > 0 ? port : 8787;
  } catch {
    return 8787;
  }
}

function readControlInfo(targetDir) {
  const file = path.join(targetDir, CONTROL_FILE);
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    if (
      typeof parsed?.port === "number" &&
      typeof parsed?.token === "string" &&
      parsed.port > 0 &&
      parsed.token
    ) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

function requestLoopback(port, method, pathname, headers, bodyText, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method,
        path: pathname,
        headers: {
          Host: `127.0.0.1:${port}`,
          ...headers,
          ...(bodyText !== undefined
            ? {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(bodyText),
              }
            : {}),
        },
        timeout: timeoutMs,
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
      },
    );
    req.on("timeout", () => req.destroy(new Error("request timeout")));
    req.on("error", reject);
    if (bodyText !== undefined) req.write(bodyText);
    req.end();
  });
}

async function copyWithRetry(src, dst) {
  let lastErr;
  for (let i = 0; i < 30; i++) {
    try {
      copyFileSync(src, dst);
      return;
    } catch (err) {
      lastErr = err;
      await sleep(150);
    }
  }
  throw lastErr;
}

async function waitForHealth(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const resp = await requestLoopback(port, "GET", "/health", {}, undefined, 800);
      if (resp.status === 200) return true;
    } catch {
      // retry
    }
    await sleep(150);
  }
  return false;
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function stopRunningTray(targetDir, logPath) {
  const ctrl = readControlInfo(targetDir);
  if (!ctrl) return;
  try {
    await requestLoopback(
      ctrl.port,
      "POST",
      "/quit",
      { "X-Tray-Token": ctrl.token },
      JSON.stringify({ includeTunnel: false }),
      2000,
    );
    appendLog(logPath, `worker.quit_sent pid=${ctrl.pid} includeTunnel=false`);
  } catch (err) {
    appendLog(logPath, `worker.quit_send_warn err=${err.message}`);
  }
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (!isPidAlive(ctrl.pid)) return;
    await sleep(100);
  }
  if (isPidAlive(ctrl.pid)) {
    try {
      execFileSync("taskkill", ["/PID", String(ctrl.pid), "/T", "/F"], { windowsHide: true });
      appendLog(logPath, `worker.force_killed pid=${ctrl.pid}`);
    } catch {
      // ignore
    }
  }
}

function spawnDetachedTray(targetDir) {
  const trayExe = path.join(targetDir, TRAY_EXE);
  const child = spawn(trayExe, [], {
    cwd: targetDir,
    env: { ...process.env },
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
  return child.pid;
}

/** 脱离主进程树的独立切换器：支持托盘自身替换 + 10 秒 /health 失败回滚 */
async function runWorker(opts) {
  const { targetDir, stageDir, delayMs, healthTimeoutMs, logPath } = opts;
  appendLog(logPath, `worker.start target=${targetDir} stage=${stageDir} delayMs=${delayMs}`);
  await sleep(delayMs);

  const files = [TRAY_EXE, SERVER_EXE, EXECUTOR_EXE];
  const mcpPort = readMcpPort(targetDir);
  mkdirSync(targetDir, { recursive: true });

  await stopRunningTray(targetDir, logPath);
  await sleep(250);

  // 备份旧三件套（严格不碰 config.json / oauth-store.json）
  const backedUp = [];
  for (const name of files) {
    const dst = path.join(targetDir, name);
    const prev = path.join(targetDir, `${name}.prev`);
    if (existsSync(dst)) {
      await copyWithRetry(dst, prev);
      backedUp.push({ dst, prev, name });
    }
  }

  try {
    for (const name of files) {
      const src = path.join(stageDir, name);
      if (existsSync(src)) {
        await copyWithRetry(src, path.join(targetDir, name));
      }
    }
    const newPid = spawnDetachedTray(targetDir);
    appendLog(logPath, `worker.spawned_new pid=${newPid} port=${mcpPort}`);

    const healthy = await waitForHealth(mcpPort, healthTimeoutMs);
    if (healthy) {
      appendLog(logPath, `worker.success port=${mcpPort}`);
      return;
    }
    throw new Error(`新版本在 ${healthTimeoutMs}ms 内未通过 127.0.0.1:${mcpPort}/health 校验`);
  } catch (err) {
    appendLog(logPath, `worker.failed err=${err.message}，开始自动回滚`);
    await stopRunningTray(targetDir, logPath);
    await sleep(250);
    for (const item of backedUp) {
      try {
        await copyWithRetry(item.prev, item.dst);
      } catch (restoreErr) {
        appendLog(logPath, `worker.restore_error file=${item.name} err=${restoreErr.message}`);
      }
    }
    if (existsSync(path.join(targetDir, TRAY_EXE))) {
      const restoredPid = spawnDetachedTray(targetDir);
      const recovered = await waitForHealth(mcpPort, healthTimeoutMs);
      appendLog(logPath, `worker.rollback_done pid=${restoredPid} recovered=${recovered}`);
    }
  }
}

async function runMain(opts) {
  if (!opts.skipBuild) {
    execSync("npm run package:stage", { cwd: rootDir, stdio: "inherit" });
  }
  if (!opts.skipSmoke) {
    execSync("npm run package:smoke", { cwd: rootDir, stdio: "inherit" });
  }

  for (const name of [TRAY_EXE, SERVER_EXE, EXECUTOR_EXE]) {
    const full = path.join(opts.stageDir, name);
    if (!existsSync(full)) {
      throw new Error(`缺少构建产物: ${full}`);
    }
  }

  const stageTrayHash = sha256File(path.join(opts.stageDir, TRAY_EXE));
  const targetTrayHash = sha256File(path.join(opts.targetDir, TRAY_EXE));
  const ctrl = readControlInfo(opts.targetDir);

  // 路径 A：运行中的托盘存在且托盘 exe 哈希未变 -> 托盘内无缝换核
  if (ctrl && stageTrayHash && stageTrayHash === targetTrayHash) {
    try {
      const resp = await requestLoopback(
        ctrl.port,
        "POST",
        "/hotswap",
        { "X-Tray-Token": ctrl.token },
        JSON.stringify({
          serverPath: path.join(opts.stageDir, SERVER_EXE),
          executorPath: path.join(opts.stageDir, EXECUTOR_EXE),
          delayMs: opts.delayMs,
          healthTimeoutMs: opts.healthTimeoutMs,
        }),
        3000,
      );
      if (resp.status === 202) {
        const payload = JSON.parse(resp.body);
        console.log(
          JSON.stringify({
            ok: true,
            mode: "in-place",
            targetDir: opts.targetDir,
            ...payload,
          }),
        );
        return;
      }
    } catch {
      // 控制端口不可达时退回脱离进程树切换器
    }
  }

  // 路径 B：托盘自身哈希变化或尚无运行中的托盘控制端口 -> 脱离进程树切换器
  const workerArgs = [
    __filename,
    "--worker",
    "--target",
    opts.targetDir,
    "--stage-dir",
    opts.stageDir,
    "--delay-ms",
    String(opts.delayMs),
    "--health-timeout-ms",
    String(opts.healthTimeoutMs),
    "--log-path",
    opts.logPath,
  ];
  const worker = spawn(process.execPath, workerArgs, {
    cwd: rootDir,
    env: { ...process.env },
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  worker.unref();

  console.log(
    JSON.stringify({
      ok: true,
      mode: "detached-worker",
      queued: true,
      targetDir: opts.targetDir,
      delayMs: opts.delayMs,
      logPath: opts.logPath,
      trayChanged: stageTrayHash !== targetTrayHash,
    }),
  );
}

const opts = parseArgs(process.argv.slice(2));
const runner = opts.worker ? runWorker(opts) : runMain(opts);
runner.catch((err) => {
  console.error(`deploy-local 失败: ${err.message}`);
  process.exit(1);
});
