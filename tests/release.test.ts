import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { projectRoot } from "./support/server.js";

const execFileAsync = promisify(execFile);
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
  it("拒绝非法语义化版本号且不修改仓库文件", async () => {
    const repo = createFakeRepo("0.1.0");
    try {
      let failed = false;
      try {
        await execFileAsync(process.execPath, [RELEASE_SCRIPT, "not-a-version", "--skip-check"], {
          env: { ...process.env, NEXUS_RELEASE_ROOT: repo.dir, NEXUS_GH_MISSING: "1" },
          encoding: "utf8",
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

  it("同步版本号到全部清单、生成精确 SHA256SUMS.txt，并默认以 --draft 调用 gh（传 --publish 去掉 --draft）", async () => {
    const repo = createFakeRepo("0.1.0");
    const ghLog = path.join(repo.dir, "gh-calls.log");
    const ghStub = writeGhStub(repo.dir, ghLog);
    const { setupSha, zipSha } = writeFakeArtifacts(repo.dir, "0.2.0");

    try {
      // 1. 默认 Draft 发布 + 同步版本号 0.2.0
      await execFileAsync(process.execPath, [RELEASE_SCRIPT, "0.2.0", "--skip-check"], {
        env: { ...process.env, NEXUS_RELEASE_ROOT: repo.dir, NEXUS_GH_STUB: ghStub },
        encoding: "utf8",
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
      await execFileAsync(process.execPath, [RELEASE_SCRIPT, "--publish", "--skip-check"], {
        env: { ...process.env, NEXUS_RELEASE_ROOT: repo.dir, NEXUS_GH_STUB: ghStub },
        encoding: "utf8",
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

  it("未安装 gh 时优雅降级：退出码 0 并打印本地产物与手动上传指引", async () => {
    const repo = createFakeRepo("0.1.0");
    writeFakeArtifacts(repo.dir, "0.1.0");
    try {
      const { stdout } = await execFileAsync(process.execPath, [RELEASE_SCRIPT, "--skip-check"], {
        env: { ...process.env, NEXUS_RELEASE_ROOT: repo.dir, NEXUS_GH_MISSING: "1" },
        encoding: "utf8",
        timeout: 15_000,
      });
      expect(stdout).toContain("SHA256SUMS.txt");
      expect(stdout).toContain("nexus-mcp_0.1.0_x64-setup.exe");
      expect(stdout).toContain("gh release create");
    } finally {
      repo.cleanup();
    }
  }, 20_000);

  it("工作区干净且 .git/last-check-ok 命中当前 HEAD 时判定检查印记有效，改动后自动失效", async () => {
    const repo = createFakeRepo("0.2.0");
    try {
      const gitEnv = {
        ...process.env,
        GIT_AUTHOR_NAME: "test",
        GIT_AUTHOR_EMAIL: "test@example.com",
        GIT_COMMITTER_NAME: "test",
        GIT_COMMITTER_EMAIL: "test@example.com",
      };
      await execFileAsync("git", ["init"], { cwd: repo.dir, env: gitEnv, timeout: 15_000 });
      await execFileAsync("git", ["add", "-A"], { cwd: repo.dir, env: gitEnv, timeout: 15_000 });
      await execFileAsync("git", ["commit", "-m", "init"], { cwd: repo.dir, env: gitEnv, timeout: 15_000 });
      const { stdout: headOut } = await execFileAsync("git", ["rev-parse", "HEAD"], {
        cwd: repo.dir,
        env: gitEnv,
        timeout: 15_000,
      });
      const head = headOut.trim();

      const mod = (await import(pathToFileURL(RELEASE_SCRIPT).href)) as {
        isCheckStampFresh?: (root: string) => { fresh: boolean; head?: string };
      };
      expect(typeof mod.isCheckStampFresh).toBe("function");

      // 无印记文件 -> false
      expect(mod.isCheckStampFresh!(repo.dir).fresh).toBe(false);

      // 写入匹配 HEAD 的印记 -> true
      writeFileSync(path.join(repo.dir, ".git", "last-check-ok"), `${head}\n`, "utf8");
      const hit = mod.isCheckStampFresh!(repo.dir);
      expect(hit.fresh).toBe(true);
      expect(hit.head).toBe(head);

      // 工作区变脏 -> false
      writeFileSync(path.join(repo.dir, "dirty.txt"), "dirty", "utf8");
      expect(mod.isCheckStampFresh!(repo.dir).fresh).toBe(false);
    } finally {
      repo.cleanup();
    }
  }, 20_000);
});
