import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, saveConfig } from "../src/config.js";
import { crashHelperBinaryPath } from "../src/executor.js";
import * as logMod from "../src/log.js";
import { projectRoot, startServer } from "./support/server.js";
import { expectOk } from "./support/tool.js";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

const savedEnv = {
  NEXUS_MCP_CONFIG: process.env.NEXUS_MCP_CONFIG,
  NEXUS_MCP_LOG_LEVEL: process.env.NEXUS_MCP_LOG_LEVEL,
  NEXUS_MCP_LOG_DIR: process.env.NEXUS_MCP_LOG_DIR,
};

function restoreEnv(): void {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

afterEach(() => {
  restoreEnv();
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("配置 logLevel 与环境变量覆盖", () => {
  it("未配置 logLevel 时默认 info，配置合法值时原样加载并可写回", () => {
    const dir = makeTempDir("nexus-log-cfg-");
    const cfgPath = path.join(dir, "config.json");
    writeFileSync(cfgPath, JSON.stringify({ root: dir, transport: "http" }), "utf8");
    process.env.NEXUS_MCP_CONFIG = cfgPath;
    delete process.env.NEXUS_MCP_LOG_LEVEL;

    const cfgDefault = loadConfig();
    expect((cfgDefault as { logLevel?: string }).logLevel).toBe("info");

    writeFileSync(cfgPath, JSON.stringify({ root: dir, transport: "http", logLevel: "debug" }), "utf8");
    const cfgDebug = loadConfig();
    expect((cfgDebug as { logLevel?: string }).logLevel).toBe("debug");

    (cfgDebug as { logLevel?: string }).logLevel = "warn";
    saveConfig(cfgDebug);
    const saved = JSON.parse(readFileSync(cfgPath, "utf8")) as { logLevel?: string };
    expect(saved.logLevel).toBe("warn");
  });

  it("NEXUS_MCP_LOG_LEVEL 覆盖 config.json 中的 logLevel", () => {
    const dir = makeTempDir("nexus-log-env-");
    const cfgPath = path.join(dir, "config.json");
    writeFileSync(cfgPath, JSON.stringify({ root: dir, transport: "http", logLevel: "warn" }), "utf8");
    process.env.NEXUS_MCP_CONFIG = cfgPath;
    process.env.NEXUS_MCP_LOG_LEVEL = "debug";

    const cfg = loadConfig();
    expect((cfg as { logLevel?: string }).logLevel).toBe("debug");
  });

  it("非法 logLevel（配置文件或环境变量）在 loadConfig 时直接报错拒绝", () => {
    const dir = makeTempDir("nexus-log-bad-");
    const cfgPath = path.join(dir, "config.json");
    writeFileSync(cfgPath, JSON.stringify({ root: dir, transport: "http", logLevel: "verbose" }), "utf8");
    process.env.NEXUS_MCP_CONFIG = cfgPath;
    delete process.env.NEXUS_MCP_LOG_LEVEL;

    expect(() => loadConfig()).toThrow(/logLevel/);

    writeFileSync(cfgPath, JSON.stringify({ root: dir, transport: "http", logLevel: "info" }), "utf8");
    process.env.NEXUS_MCP_LOG_LEVEL = "trace";
    expect(() => loadConfig()).toThrow(/NEXUS_MCP_LOG_LEVEL/);
  });
});

describe("服务日志目录路由、滚动落盘、四级阈值与脱敏", () => {
  afterEach(() => {
    const mod = logMod as Record<string, unknown>;
    if (typeof mod.configureLogger === "function") {
      (mod.configureLogger as (opts: Record<string, unknown>) => void)({
        level: "info",
        logDir: null,
        resetRing: true,
      });
    }
  });

  it("目录路由严格按优先级：NEXUS_MCP_LOG_DIR > NEXUS_MCP_CONFIG 同级 logs > 开发态 .scratch/logs > 打包版 logs", () => {
    const resolveLogDir = (logMod as {
      resolveLogDir?: (opts?: { env?: NodeJS.ProcessEnv; packaged?: boolean; rootDir?: string }) => string;
    }).resolveLogDir;
    expect(typeof resolveLogDir).toBe("function");

    const customLogDir = path.join(os.tmpdir(), "custom-logs");
    const cfgFile = path.join(os.tmpdir(), "isolated-cfg", "config.json");
    const repoRoot = path.join(os.tmpdir(), "fake-repo");

    expect(
      resolveLogDir!({
        env: { NEXUS_MCP_LOG_DIR: customLogDir, NEXUS_MCP_CONFIG: cfgFile },
        packaged: false,
        rootDir: repoRoot,
      }),
    ).toBe(path.resolve(customLogDir));

    expect(
      resolveLogDir!({
        env: { NEXUS_MCP_CONFIG: cfgFile },
        packaged: false,
        rootDir: repoRoot,
      }),
    ).toBe(path.join(path.dirname(path.resolve(cfgFile)), "logs"));

    expect(
      resolveLogDir!({
        env: {},
        packaged: false,
        rootDir: repoRoot,
      }),
    ).toBe(path.join(repoRoot, ".scratch", "logs"));

    expect(
      resolveLogDir!({
        env: {},
        packaged: true,
        rootDir: repoRoot,
      }),
    ).toBe(path.join(repoRoot, "logs"));
  });

  it("按 UTC 日期命名、统一单行格式，且四级阈值同时控制 stderr、内存环与磁盘文件", () => {
    const dir = makeTempDir("nexus-log-sink-");
    const stderrLines: string[] = [];
    const fixedDate = new Date("2026-11-26T08:09:10.123Z");

    const configureLogger = (logMod as Record<string, (...args: unknown[]) => unknown>).configureLogger;
    const logEvent = (logMod as Record<string, (...args: unknown[]) => unknown>).logEvent;
    expect(typeof configureLogger).toBe("function");
    expect(typeof logEvent).toBe("function");

    configureLogger!({
      level: "warn",
      logDir: dir,
      now: () => fixedDate,
      writeStderr: (line: string) => stderrLines.push(line),
      resetRing: true,
    });

    logEvent!("debug", "tool.start", { sid: "stdio", tool: "read" });
    logEvent!("info", "tool.ok", { sid: "stdio", tool: "read", ms: 5 });
    logEvent!("warn", "tool.err", { sid: "stdio", tool: "bash", ms: 12, err: "被拦截" });
    logEvent!("error", "executor.error", { op: "bash", err: "crashed" });

    const ring = logMod.recentLogs();
    expect(ring).toHaveLength(2);
    expect(ring[0]).toBe("2026-11-26T08:09:10.123Z [WARN] [tool.err] sid=stdio tool=bash ms=12 err=被拦截");
    expect(ring[1]).toBe("2026-11-26T08:09:10.123Z [ERROR] [executor.error] op=bash err=crashed");

    expect(stderrLines).toHaveLength(2);
    expect(stderrLines[0]).toBe(`[nexus-mcp] ${ring[0]}`);
    expect(stderrLines[1]).toBe(`[nexus-mcp] ${ring[1]}`);

    const logFile = path.join(dir, "nexus-mcp-2026-11-26.log");
    expect(existsSync(logFile)).toBe(true);
    const diskLines = readFileSync(logFile, "utf8").trim().split("\n");
    expect(diskLines).toEqual(ring);
  });

  it("单文件达上限自动切分滚动（.1.log/.2.log），且启动与切分时只保留最近 10 个日志文件", () => {
    const dir = makeTempDir("nexus-log-rotate-");
    // 预放 12 个历史日志文件，测试启动清理保留最近 10 个
    for (let i = 1; i <= 12; i++) {
      const day = String(i).padStart(2, "0");
      writeFileSync(path.join(dir, `nexus-mcp-2026-10-${day}.log`), `old-${i}\n`, "utf8");
    }
    // 非日志文件不应被误删
    writeFileSync(path.join(dir, "keep-me.txt"), "keep", "utf8");

    const configureLogger = (logMod as Record<string, (...args: unknown[]) => unknown>).configureLogger;
    const logEvent = (logMod as Record<string, (...args: unknown[]) => unknown>).logEvent;

    configureLogger!({
      level: "info",
      logDir: dir,
      maxFileBytes: 180,
      maxFiles: 10,
      now: () => new Date("2026-11-26T10:00:00.000Z"),
      writeStderr: () => {},
      resetRing: true,
    });

    const afterInit = readdirSync(dir).filter((f) => f.endsWith(".log"));
    expect(afterInit.length).toBeLessThanOrEqual(10);
    expect(existsSync(path.join(dir, "keep-me.txt"))).toBe(true);

    // 连续写入触发多次切分滚动
    for (let i = 0; i < 8; i++) {
      logEvent!("info", "tool.ok", { sid: "abcd1234", tool: "read", path: `file-${i}.ts`, ms: i });
    }

    const filesAfterRotate = readdirSync(dir).filter((f) => f.endsWith(".log"));
    expect(filesAfterRotate.length).toBeLessThanOrEqual(10);
    expect(filesAfterRotate.some((f) => f === "nexus-mcp-2026-11-26.log")).toBe(true);
    expect(filesAfterRotate.some((f) => /^nexus-mcp-2026-11-26\.\d+\.log$/.test(f))).toBe(true);
  });

  it("全局脱敏抹除 config.token 以及 TOKEN=、PASSWORD=、SECRET=、KEY=、Bearer 形态", () => {
    const dir = makeTempDir("nexus-log-redact-");
    const stderrLines: string[] = [];
    const secret = "super-secret-token-98765";

    const configureLogger = (logMod as Record<string, (...args: unknown[]) => unknown>).configureLogger;
    const logEvent = (logMod as Record<string, (...args: unknown[]) => unknown>).logEvent;

    configureLogger!({
      level: "info",
      logDir: dir,
      getSecret: () => secret,
      now: () => new Date("2026-11-26T10:00:00.000Z"),
      writeStderr: (line: string) => stderrLines.push(line),
      resetRing: true,
    });

    logEvent!("info", "tool.ok", {
      sid: "stdio",
      tool: "bash",
      cmd: `API_KEY=abc123 TOKEN=tok999 PASSWORD="pw 123" SECRET=sec_xyz curl -H "Bearer bear_777" ${secret}`,
    });

    const line = logMod.recentLogs()[0] ?? "";
    expect(line).not.toContain(secret);
    expect(line).not.toContain("abc123");
    expect(line).not.toContain("tok999");
    expect(line).not.toContain("pw 123");
    expect(line).not.toContain("sec_xyz");
    expect(line).not.toContain("bear_777");
    expect(line).toContain("API_KEY=***");
    expect(line).toContain("TOKEN=***");
    expect(line).toContain("PASSWORD=***");
    expect(line).toContain("SECRET=***");
    expect(line).toContain("Bearer ***");
    expect(stderrLines[0]).not.toContain(secret);
  });
});

function readDiskLogText(configPath: string): string {
  const logDir = path.join(path.dirname(configPath), "logs");
  expect(existsSync(logDir)).toBe(true);
  const files = readdirSync(logDir).filter((f) => /^nexus-mcp-\d{4}-\d{2}-\d{2}\.log$/.test(f));
  expect(files.length).toBeGreaterThan(0);
  return files.map((f) => readFileSync(path.join(logDir, f), "utf8")).join("\n");
}

function textOf(result: unknown): string {
  const parts =
    ((result as { content?: unknown }).content as Array<{ type: string; text?: string }> | undefined) ??
    [];
  return parts.map((p) => p.text ?? "").join("\n");
}

describe("端到端服务日志与工具调用全链路摘要", () => {
  it(
    "HTTP 模式 9 个工具均产出 tool.ok/tool.err、严守脱敏红线，且空轮询 job_output 降级为 DEBUG",
    async () => {
      const sandboxDir = makeTempDir("nexus-log-e2e-http-");
      const token = "e2e-secret-tok-9941";
      const server = await startServer({
        root: sandboxDir,
        token,
        commandPolicy: { allow: [], deny: ["echo blocked*"], onUnmatched: "deny" },
      });

      const transport = new StreamableHTTPClientTransport(server.mcpUrl, {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      });
      const client = new Client({ name: "vitest-log-http", version: "0.1.0" });

      try {
        await client.connect(transport);
        const sidShort = (transport.sessionId ?? "").slice(0, 8);
        expect(sidShort).toHaveLength(8);

        // 1. write
        expectOk(
          await client.callTool({
            name: "write",
            arguments: {
              path: "note.txt",
              content: "SECRET_BODY_WRITE_999\nSECRET_OLD_EDIT_888\nGREP_FIND_ME SECRET_GREP_LINE_BODY_654\n",
            },
          }),
        );
        // 2. read
        expectOk(
          await client.callTool({
            name: "read",
            arguments: { path: "note.txt", offset: 1, limit: 10 },
          }),
        );
        // 3. edit
        expectOk(
          await client.callTool({
            name: "edit",
            arguments: {
              path: "note.txt",
              old_string: "SECRET_OLD_EDIT_888",
              new_string: "SECRET_NEW_EDIT_777",
            },
          }),
        );
        // 4. glob（超长 pattern 测试截断）
        const longPattern = `${"a".repeat(95)}*.txt`;
        expectOk(await client.callTool({ name: "glob", arguments: { pattern: longPattern } }));
        // 5. grep（验证只记 pattern，不漏匹配行正文）
        expectOk(await client.callTool({ name: "grep", arguments: { pattern: "GREP_FIND_ME" } }));
        // 6. bash（含敏感环境变量 + cat 输出文件正文，以及命令闸门拦截）
        expectOk(
          await client.callTool({
            name: "bash",
            arguments: { command: "PASSWORD=pw_secret_555 cat note.txt" },
          }),
        );
        const blocked = await client.callTool({
          name: "bash",
          arguments: { command: "echo blocked123" },
        });
        expect(blocked.isError).toBe(true);

        // 7-9. job_start / job_output（空轮询）/ job_kill
        const started = await client.callTool({
          name: "job_start",
          arguments: { command: "sleep 3" },
        });
        expectOk(started);
        const jobId = /job-\d+/.exec(textOf(started))?.[0];
        expect(jobId).toBeTruthy();

        // 立即空轮询（status=running 且 0 字节输出 -> 应降级为 DEBUG，info 下不出现）
        const emptyPoll = await client.callTool({
          name: "job_output",
          arguments: { job_id: jobId!, offset: 0 },
        });
        expectOk(emptyPoll);

        // 终止后台任务
        expectOk(await client.callTool({ name: "job_kill", arguments: { job_id: jobId! } }));

        // 轮询直到任务收敛为 exited，确保产出 INFO 级 job_output tool.ok
        const exitDeadline = Date.now() + 5_000;
        let finalOutText = "";
        while (Date.now() < exitDeadline) {
          const poll = await client.callTool({
            name: "job_output",
            arguments: { job_id: jobId!, offset: 0 },
          });
          expectOk(poll);
          finalOutText = textOf(poll);
          if (finalOutText.includes("status: exited")) break;
          await new Promise((r) => setTimeout(r, 50));
        }
        expect(finalOutText).toContain("status: exited");

        const logsRes = await fetch(`${server.panelUrl}/api/logs`);
        expect(logsRes.status).toBe(200);
        const panelLogs = ((await logsRes.json()) as { lines: string[] }).lines;
        const diskText = readDiskLogText(server.configPath);
        const stderrText = server.stderrText();

        for (const text of [panelLogs.join("\n"), diskText, stderrText]) {
          // 9 个工具均出现 tool.ok
          for (const tool of [
            "read",
            "write",
            "edit",
            "glob",
            "grep",
            "bash",
            "job_start",
            "job_output",
            "job_kill",
          ]) {
            expect(text).toContain(`[INFO] [tool.ok] sid=${sidShort} tool=${tool}`);
          }
          // 命令闸门拦截记为 WARN tool.err
          expect(text).toContain(`[WARN] [tool.err] sid=${sidShort} tool=bash`);
          // info 级别下不含 DEBUG / tool.start / ipc.done
          expect(text).not.toContain("[DEBUG]");
          expect(text).not.toContain("[tool.start]");
          expect(text).not.toContain("[ipc.done]");
          // 脱敏红线
          expect(text).not.toContain(token);
          expect(text).not.toContain("SECRET_BODY_WRITE_999");
          expect(text).not.toContain("SECRET_OLD_EDIT_888");
          expect(text).not.toContain("SECRET_NEW_EDIT_777");
          expect(text).not.toContain("SECRET_GREP_LINE_BODY_654");
          expect(text).not.toContain("pw_secret_555");
          expect(text).not.toContain(longPattern);
          expect(text.toLowerCase()).not.toContain("authorization");
        }
        // 空轮询（status=running bytes=0）在 info 级别下不应出现
        expect(diskText).not.toContain("tool=job_output status=running bytes=0");
      } finally {
        await transport.terminateSession().catch(() => {});
        await client.close().catch(() => {});
        await server.stop();
      }
    },
    30_000,
  );

  it(
    "debug 等级额外记录 tool.start、ipc.done 与空轮询 job_output，执行器崩溃记 ERROR",
    async () => {
      const sandboxDir = makeTempDir("nexus-log-e2e-debug-");
      writeFileSync(path.join(sandboxDir, "hello.txt"), "hi\n", "utf8");
      const server = await startServer({ root: sandboxDir, logLevel: "debug" });
      const transport = new StreamableHTTPClientTransport(server.mcpUrl);
      const client = new Client({ name: "vitest-log-debug", version: "0.1.0" });

      try {
        await client.connect(transport);
        expectOk(await client.callTool({ name: "read", arguments: { path: "hello.txt" } }));

        const started = await client.callTool({
          name: "job_start",
          arguments: { command: "sleep 3" },
        });
        expectOk(started);
        const jobId = /job-\d+/.exec(textOf(started))?.[0];
        expect(jobId).toBeTruthy();

        expectOk(await client.callTool({ name: "job_output", arguments: { job_id: jobId!, offset: 0 } }));
        expectOk(await client.callTool({ name: "job_kill", arguments: { job_id: jobId! } }));

        const diskText = readDiskLogText(server.configPath);
        expect(diskText).toContain("[DEBUG] [tool.start]");
        expect(diskText).toContain("[DEBUG] [ipc.done]");
        expect(diskText).toMatch(/\[DEBUG\] \[ipc\.done\] id=\d+ op=read ms=\d+/);
        expect(diskText).toMatch(/\[DEBUG\] \[tool\.ok\] sid=[0-9a-f-]+ tool=job_output/);
      } finally {
        await transport.terminateSession().catch(() => {});
        await client.close().catch(() => {});
        await server.stop();
      }

      // 执行器崩溃记 ERROR
      const crashServer = await startServer({
        root: sandboxDir,
        env: { NEXUS_MCP_EXECUTOR: crashHelperBinaryPath() },
      });
      const crashTransport = new StreamableHTTPClientTransport(crashServer.mcpUrl);
      const crashClient = new Client({ name: "vitest-log-crash", version: "0.1.0" });
      try {
        await crashClient.connect(crashTransport);
        const failed = await crashClient.callTool({ name: "read", arguments: { path: "hello.txt" } });
        expect(failed.isError).toBe(true);
        const crashDiskText = readDiskLogText(crashServer.configPath);
        expect(crashDiskText).toContain("[ERROR]");
      } finally {
        await crashTransport.terminateSession().catch(() => {});
        await crashClient.close().catch(() => {});
        await crashServer.stop();
      }
    },
    30_000,
  );

  it(
    "stdio 模式不污染 stdout 协议通道，并在隔离目录写入 sid=stdio 的日志文件",
    async () => {
      const cfgDir = makeTempDir("nexus-log-e2e-stdio-");
      const cfgPath = path.join(cfgDir, "config.json");
      writeFileSync(
        cfgPath,
        JSON.stringify({ root: projectRoot, transport: "stdio", logLevel: "info" }, null, 2),
        "utf8",
      );

      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [path.join(projectRoot, "dist", "index.js"), "--stdio"],
        cwd: projectRoot,
        env: { ...process.env, NEXUS_MCP_CONFIG: cfgPath } as Record<string, string>,
        stderr: "pipe",
      });
      let stderrOut = "";
      transport.stderr?.on("data", (chunk: Buffer) => {
        stderrOut += chunk.toString("utf8");
      });

      const client = new Client({ name: "vitest-log-stdio", version: "0.1.0" });
      try {
        await client.connect(transport);
        const res = await client.callTool({ name: "read", arguments: { path: "package.json" } });
        expectOk(res);
        expect(textOf(res)).toContain('"name": "nexus-mcp"');

        const diskText = readDiskLogText(cfgPath);
        expect(diskText).toContain("[INFO] [tool.ok] sid=stdio tool=read");
        expect(stderrOut).toContain("[nexus-mcp]");
        expect(stderrOut).toContain("[INFO] [tool.ok] sid=stdio tool=read");
      } finally {
        await client.close().catch(() => {});
      }
    },
    20_000,
  );
});
