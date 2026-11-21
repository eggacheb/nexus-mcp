import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configFilePath, loadConfig } from "../src/config.js";
import { appRoot, isPackaged } from "../src/paths.js";
import { VERSION } from "../src/version.js";
import { projectRoot } from "./support/server.js";

const TOUCHED = ["NEXUS_MCP_CONFIG", "NEXUS_MCP_TOKEN", "NEXUS_MCP_ROOT", "NEXUS_MCP_PORT"] as const;

describe("打包与配置优先级", () => {
  let dir = "";
  const saved = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const key of TOUCHED) {
      saved.set(key, process.env[key]);
      delete process.env[key];
    }
    dir = mkdtempSync(path.join(os.tmpdir(), "nexus-mcp-pkg-"));
    process.env.NEXUS_MCP_CONFIG = path.join(dir, "config.json");
  });

  afterEach(() => {
    for (const key of TOUCHED) {
      const value = saved.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    saved.clear();
    rmSync(dir, { recursive: true, force: true });
  });

  function configFile(): string {
    return process.env.NEXUS_MCP_CONFIG as string;
  }

  function writeConfig(body: Record<string, unknown>): void {
    writeFileSync(configFile(), `${JSON.stringify(body, null, 2)}\n`, "utf8");
  }

  it("版本号只有一处来源，且与 package.json 一致", () => {
    const pkg = JSON.parse(readFileSync(path.join(projectRoot, "package.json"), "utf8")) as {
      version: string;
    };
    expect(VERSION).toBe(pkg.version);
  });

  it("首次运行缺配置时生成默认配置，不抛错", () => {
    expect(existsSync(configFile())).toBe(false);

    const config = loadConfig();

    expect(existsSync(configFile())).toBe(true);
    const written = JSON.parse(readFileSync(configFile(), "utf8")) as {
      token?: string;
      port?: number;
      panelPort?: number;
      root?: string;
    };
    // 令牌必须随机且够长，否则打包版默认不带鉴权
    expect(written.token).toMatch(/^[0-9a-f]{32}$/);
    expect(config.token).toBe(written.token);
    expect(written.port).toBe(8787);
    expect(written.panelPort).toBe(8788);
    expect(path.isAbsolute(written.root as string)).toBe(true);
  });

  it("环境变量优先于同目录 config.json", () => {
    writeConfig({ root: projectRoot, port: 9123, token: "file-token", shell: "auto" });
    const envRoot = path.join(dir, "env-root");
    process.env.NEXUS_MCP_TOKEN = "env-token";
    process.env.NEXUS_MCP_PORT = "9321";
    process.env.NEXUS_MCP_ROOT = envRoot;

    const config = loadConfig();

    expect(config.token).toBe("env-token");
    expect(config.port).toBe(9321);
    expect(config.panelPort).toBe(9322);
    expect(config.root).toBe(path.resolve(envRoot));
  });

  it("没有环境变量时回落到 config.json 的值", () => {
    writeConfig({ root: projectRoot, port: 9123, token: "file-token", shell: "auto" });

    const config = loadConfig();

    expect(config.token).toBe("file-token");
    expect(config.port).toBe(9123);
    expect(config.panelPort).toBe(9124);
    expect(config.root).toBe(projectRoot);
  });

  it("空字符串环境变量按未设置处理", () => {
    writeConfig({ root: projectRoot, token: "file-token", shell: "auto" });
    process.env.NEXUS_MCP_TOKEN = "";

    expect(loadConfig().token).toBe("file-token");
  });

  it("文件里缺的字段回落到内置默认值", () => {
    writeConfig({ root: projectRoot, shell: "auto" });

    const config = loadConfig();

    expect(config.port).toBe(8787);
    expect(config.panelPort).toBe(8788);
    expect(config.maxOutputBytes).toBe(64 * 1024);
    expect(config.defaultTimeoutMs).toBe(120_000);
    expect(config.commandPolicy).toEqual({ allow: [], deny: [], onUnmatched: "deny" });
  });

  it("NEXUS_MCP_CONFIG 指定的路径优先于程序根目录", () => {
    expect(configFilePath()).toBe(path.resolve(configFile()));
    expect(configFilePath()).not.toBe(path.join(appRoot, "config.json"));
  });

  it("没有 NEXUS_MCP_CONFIG 时，配置取程序根目录的 config.json", () => {
    const saved = process.env.NEXUS_MCP_CONFIG;
    delete process.env.NEXUS_MCP_CONFIG;
    try {
      expect(configFilePath()).toBe(path.join(appRoot, "config.json"));
    } finally {
      process.env.NEXUS_MCP_CONFIG = saved;
    }
  });

  it("开发态不判定为打包，程序根目录就是仓库根", () => {
    expect(isPackaged).toBe(false);
    expect(appRoot).toBe(projectRoot);
  });
});
