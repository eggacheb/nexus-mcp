import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { projectRoot } from "./support/server.js";

const RELEASE_SCRIPT = path.join(projectRoot, "scripts", "release.mjs");

function createFakeRepo(version = "0.1.0"): { dir: string; cleanup(): void } {
  const dir = mkdtempSync(path.join(os.tmpdir(), "nexus-release-test-"));
  mkdirSync(path.join(dir, "src"), { recursive: true });
  mkdirSync(path.join(dir, "crates", "executor"), { recursive: true });
  mkdirSync(path.join(dir, "crates", "tray"), { recursive: true });
  mkdirSync(path.join(dir, "release"), { recursive: true });

  writeFileSync(
    path.join(dir, "package.json"),
    `${JSON.stringify({ name: "nexus-mcp", version }, null, 2)}\n`,
    "utf8",
  );
  writeFileSync(
    path.join(dir, "src", "version.ts"),
    `export const VERSION = "${version}";\n`,
    "utf8",
  );
  writeFileSync(
    path.join(dir, "crates", "executor", "Cargo.toml"),
    `[package]\nname = "nexus-executor"\nversion = "${version}"\nedition = "2024"\n`,
    "utf8",
  );
  writeFileSync(
    path.join(dir, "crates", "tray", "Cargo.toml"),
    `[package]\nname = "nexus-mcp"\nversion = "${version}"\nedition = "2024"\n`,
    "utf8",
  );

  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function writeFakeArtifacts(repoDir: string, version: string): { setupSha: string; zipSha: string } {
  const setupBytes = Buffer.from(`fake-setup-${version}`);
  const zipBytes = Buffer.from(`fake-zip-${version}`);
  writeFileSync(path.join(repoDir, "release", `nexus-mcp_${version}_x64-setup.exe`), setupBytes);
  writeFileSync(path.join(repoDir, "release", `nexus-mcp-${version}-win64.zip`), zipBytes);
  return {
    setupSha: createHash("sha256").update(setupBytes).digest("hex"),
    zipSha: createHash("sha256").update(zipBytes).digest("hex"),
  };
}

function writeGhStub(dir: string, logPath: string): string {
  const stubPath = path.join(dir, "gh-stub.cjs");
  writeFileSync(
    stubPath,
    `
const fs = require("fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(args) + "\\n");
process.exit(0);
`,
    "utf8",
  );
  return stubPath;
}

describe("本地一键 Release 脚本（scripts/release.mjs）", () => {
  it("拒绝非法语义化版本号且不修改仓库文件", () => {
    const repo = createFakeRepo("0.1.0");
    try {
      let failed = false;
      try {
        execFileSync(process.execPath, [RELEASE_SCRIPT, "not-a-version", "--skip-check"], {
          env: { ...process.env, NEXUS_RELEASE_ROOT: repo.dir, NEXUS_GH_MISSING: "1" },
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          timeout: 15_000,
        });
      } catch (error) {
        failed = true;
        const stderr = String((error as { stderr?: unknown }).stderr ?? "");
        expect(stderr).toContain("版本号");
      }
      expect(failed).toBe(true);
      const pkg = JSON.parse(readFileSync(path.join(repo.dir, "package.json"), "utf8")) as {
        version: string;
      };
      expect(pkg.version).toBe("0.1.0");
    } finally {
      repo.cleanup();
    }
  }, 20_000);

  it("同步版本号到全部清单、生成精确 SHA256SUMS.txt，并默认以 --draft 调用 gh（传 --publish 去掉 --draft）", () => {
    const repo = createFakeRepo("0.1.0");
    const ghLog = path.join(repo.dir, "gh-calls.log");
    const ghStub = writeGhStub(repo.dir, ghLog);
    const { setupSha, zipSha } = writeFakeArtifacts(repo.dir, "0.2.0");

    try {
      // 1. 默认 Draft 发布 + 同步版本号 0.2.0
      execFileSync(process.execPath, [RELEASE_SCRIPT, "0.2.0", "--skip-check"], {
        env: { ...process.env, NEXUS_RELEASE_ROOT: repo.dir, NEXUS_GH_STUB: ghStub },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 15_000,
      });

      expect(JSON.parse(readFileSync(path.join(repo.dir, "package.json"), "utf8")).version).toBe("0.2.0");
      expect(readFileSync(path.join(repo.dir, "src", "version.ts"), "utf8")).toContain('VERSION = "0.2.0"');
      expect(readFileSync(path.join(repo.dir, "crates", "executor", "Cargo.toml"), "utf8")).toContain(
        'version = "0.2.0"',
      );
      expect(readFileSync(path.join(repo.dir, "crates", "tray", "Cargo.toml"), "utf8")).toContain(
        'version = "0.2.0"',
      );

      const sumsPath = path.join(repo.dir, "release", "SHA256SUMS.txt");
      expect(existsSync(sumsPath)).toBe(true);
      const sums = readFileSync(sumsPath, "utf8");
      expect(sums).toContain(`${setupSha}  nexus-mcp_0.2.0_x64-setup.exe`);
      expect(sums).toContain(`${zipSha}  nexus-mcp-0.2.0-win64.zip`);

      const draftCalls = readFileSync(ghLog, "utf8")
        .trim()
        .split(/\r?\n/)
        .map((line) => JSON.parse(line) as string[]);
      const draftCreate = draftCalls.find((c) => c[0] === "release" && c[1] === "create");
      expect(draftCreate).toBeDefined();
      expect(draftCreate).toContain("v0.2.0");
      expect(draftCreate).toContain("--draft");

      // 2. 传 --publish 去掉 --draft
      writeFileSync(ghLog, "", "utf8");
      execFileSync(process.execPath, [RELEASE_SCRIPT, "--publish", "--skip-check"], {
        env: { ...process.env, NEXUS_RELEASE_ROOT: repo.dir, NEXUS_GH_STUB: ghStub },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 15_000,
      });
      const pubCalls = readFileSync(ghLog, "utf8")
        .trim()
        .split(/\r?\n/)
        .map((line) => JSON.parse(line) as string[]);
      const pubCreate = pubCalls.find((c) => c[0] === "release" && c[1] === "create");
      expect(pubCreate).toBeDefined();
      expect(pubCreate).toContain("v0.2.0");
      expect(pubCreate).not.toContain("--draft");
    } finally {
      repo.cleanup();
    }
  }, 20_000);

  it("未安装 gh 时优雅降级：退出码 0 并打印本地产物与手动上传指引", () => {
    const repo = createFakeRepo("0.1.0");
    writeFakeArtifacts(repo.dir, "0.1.0");
    try {
      const stdout = execFileSync(process.execPath, [RELEASE_SCRIPT, "--skip-check"], {
        env: { ...process.env, NEXUS_RELEASE_ROOT: repo.dir, NEXUS_GH_MISSING: "1" },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 15_000,
      });
      expect(stdout).toContain("SHA256SUMS.txt");
      expect(stdout).toContain("nexus-mcp_0.1.0_x64-setup.exe");
      expect(stdout).toContain("gh release create");
    } finally {
      repo.cleanup();
    }
  }, 20_000);
});
