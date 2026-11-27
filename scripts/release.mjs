/**
 * 本地一键发布脚本（遵守 ADR-0003：不启用 GitHub Actions）：
 *   node scripts/release.mjs [<semver>] [--publish] [--skip-check]
 *
 * 流程：
 *   1. 若传入 <semver>，校验并同步更新 package.json、src/version.ts 与两个 Cargo.toml；
 *   2. 跑全量 npm run check → npm run package → npm run package:smoke（--skip-check 仅测试隔离用）；
 *   3. 为 release/ 下的安装包与绿色 zip 生成 SHA256SUMS.txt；
 *   4. 检测本机 gh CLI 登录态：可用时调用 gh release create（默认 --draft，传 --publish 直发）；
 *      不可用时打印产物清单与手动上传命令并以退出码 0 结束。
 */
import { execFileSync, execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

function fail(message) {
  console.error(`发布失败：${message}`);
  process.exit(1);
}

function step(title) {
  console.log(`\n== ${title}`);
}

function parseArgs(argv) {
  let targetVersion = "";
  let publish = false;
  let skipCheck = false;
  let forceCheck = false;
  for (const arg of argv) {
    if (arg === "--publish") {
      publish = true;
    } else if (arg === "--skip-check") {
      skipCheck = true;
    } else if (arg === "--force-check") {
      forceCheck = true;
    } else if (arg.startsWith("-")) {
      fail(`未知参数：${arg}`);
    } else if (!targetVersion) {
      targetVersion = arg.trim();
    } else {
      fail(`多余的位置参数：${arg}`);
    }
  }
  return { targetVersion, publish, skipCheck, forceCheck };
}

/** 工作区干净且 .git/last-check-ok 与当前 HEAD 一致时返回 fresh=true，免重复跑 55s 全量检查 */
export function isCheckStampFresh(root) {
  try {
    const cleanEnv = { ...process.env };
    delete cleanEnv.GIT_DIR;
    delete cleanEnv.GIT_WORK_TREE;
    delete cleanEnv.GIT_INDEX_FILE;
    const status = execFileSync("git", ["status", "--porcelain"], {
      cwd: root,
      env: cleanEnv,
      encoding: "utf8",
      stdio: "pipe",
    }).trim();
    if (status) return { fresh: false };
    const gitDirRaw = execFileSync("git", ["rev-parse", "--git-dir"], {
      cwd: root,
      env: cleanEnv,
      encoding: "utf8",
      stdio: "pipe",
    }).trim();
    const gitDir = path.isAbsolute(gitDirRaw) ? gitDirRaw : path.resolve(root, gitDirRaw);
    const stampPath = path.join(gitDir, "last-check-ok");
    if (!existsSync(stampPath)) return { fresh: false };
    const stamp = readFileSync(stampPath, "utf8").trim();
    const head = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      env: cleanEnv,
      encoding: "utf8",
      stdio: "pipe",
    }).trim();
    return stamp && stamp === head ? { fresh: true, head } : { fresh: false, head };
  } catch {
    return { fresh: false };
  }
}

function hasBuiltArtifacts(root) {
  return (
    existsSync(path.join(root, "dist", "index.js")) &&
    existsSync(path.join(root, "crates", "target", "release", "nexus-executor.exe")) &&
    existsSync(path.join(root, "crates", "target", "release", "nexus-mcp.exe"))
  );
}

function syncVersion(root, nextVersion) {
  if (!SEMVER_RE.test(nextVersion)) {
    fail(`版本号格式不合法（需为语义化版本如 0.2.0）：${nextVersion}`);
  }

  // 1. package.json
  const pkgPath = path.join(root, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  pkg.version = nextVersion;
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, "utf8");

  // 2. src/version.ts
  const versionTsPath = path.join(root, "src", "version.ts");
  if (existsSync(versionTsPath)) {
    const raw = readFileSync(versionTsPath, "utf8");
    const updated = raw.replace(
      /export const VERSION = "[^"]+";/,
      `export const VERSION = "${nextVersion}";`,
    );
    writeFileSync(versionTsPath, updated, "utf8");
  }

  // 3. crates/{executor,tray}/Cargo.toml
  for (const rel of [
    path.join("crates", "executor", "Cargo.toml"),
    path.join("crates", "tray", "Cargo.toml"),
  ]) {
    const cargoPath = path.join(root, rel);
    if (!existsSync(cargoPath)) continue;
    const raw = readFileSync(cargoPath, "utf8");
    const updated = raw.replace(/^version\s*=\s*"[^"]+"/m, `version = "${nextVersion}"`);
    writeFileSync(cargoPath, updated, "utf8");
  }
}

function sha256File(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function runGh(args, cwd) {
  const stub = process.env.NEXUS_GH_STUB?.trim();
  if (stub) {
    return execFileSync(process.execPath, [stub, ...args], {
      cwd,
      encoding: "utf8",
      stdio: "pipe",
    });
  }
  return execFileSync("gh", args, {
    cwd,
    encoding: "utf8",
    stdio: "pipe",
  });
}

function isGhReady(cwd) {
  if (process.env.NEXUS_GH_MISSING === "1") return false;
  try {
    runGh(["auth", "status"], cwd);
    return true;
  } catch {
    return false;
  }
}

function main() {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const root = process.env.NEXUS_RELEASE_ROOT?.trim()
    ? path.resolve(process.env.NEXUS_RELEASE_ROOT.trim())
    : path.resolve(scriptDir, "..");

  const { targetVersion, publish, skipCheck, forceCheck } = parseArgs(process.argv.slice(2));

  if (targetVersion) {
    step(`同步版本号到 ${targetVersion}`);
    syncVersion(root, targetVersion);
  }

  const pkgPath = path.join(root, "package.json");
  if (!existsSync(pkgPath)) fail(`找不到 ${pkgPath}`);
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  const version = String(pkg.version ?? "").trim();
  if (!SEMVER_RE.test(version)) {
    fail(`package.json 中的版本号不合法：${version}`);
  }

  if (!skipCheck) {
    const stamp = !forceCheck && !targetVersion ? isCheckStampFresh(root) : { fresh: false };
    if (stamp.fresh && hasBuiltArtifacts(root)) {
      step(`HEAD ${stamp.head} 已通过全量 npm run check 且构建产物齐全，跳过重复检查`);
    } else {
      step("执行全量本地检查（npm run check）");
      execSync("npm run check", { cwd: root, stdio: "inherit" });
    }

    // npm run check 已完成 build，直接跑 scripts/package.ts 跳过重复 cargo/tsc 构建
    step("打包 NSIS 安装包与绿色 zip（scripts/package.ts）");
    const tsxCli = path.join(root, "node_modules", "tsx", "dist", "cli.mjs");
    if (existsSync(tsxCli)) {
      execFileSync(process.execPath, [tsxCli, path.join(root, "scripts", "package.ts")], {
        cwd: root,
        stdio: "inherit",
      });
    } else {
      execSync("npm run package", { cwd: root, stdio: "inherit" });
    }

    step("验证打包产物冒烟（npm run package:smoke）");
    execSync("npm run package:smoke", { cwd: root, stdio: "inherit" });
  }

  const releaseDir = path.join(root, "release");
  const setupName = `nexus-mcp_${version}_x64-setup.exe`;
  const zipName = `nexus-mcp-${version}-win64.zip`;
  const setupPath = path.join(releaseDir, setupName);
  const zipPath = path.join(releaseDir, zipName);

  for (const file of [setupPath, zipPath]) {
    if (!existsSync(file)) fail(`缺少发布产物：${file}`);
  }

  step("生成 SHA256SUMS.txt");
  const setupSha = sha256File(setupPath);
  const zipSha = sha256File(zipPath);
  const sumsPath = path.join(releaseDir, "SHA256SUMS.txt");
  writeFileSync(
    sumsPath,
    `${setupSha}  ${setupName}\n${zipSha}  ${zipName}\n`,
    "utf8",
  );

  const tag = `v${version}`;
  const notes = [
    `## nexus-mcp ${tag}`,
    "",
    "- **Windows 安装包**：`" + setupName + "`（推荐，按用户安装，装完自动打开控制面板）",
    "- **绿色便携版**：`" + zipName + "`（解压双击 `nexus-mcp.exe`）",
    "- **校验和**：`SHA256SUMS.txt`",
    "",
    "> 首次运行如遇 Windows SmartScreen 拦截，点「更多信息 → 仍要运行」即可。",
  ].join("\n");

  const ghArgs = [
    "release",
    "create",
    tag,
    setupPath,
    zipPath,
    sumsPath,
    "--title",
    `nexus-mcp ${tag}`,
    "--notes",
    notes,
    ...(publish ? [] : ["--draft"]),
  ];

  if (!isGhReady(root)) {
    console.log(`\n本地发布产物已就绪（未检测到已登录的 gh CLI，已跳过自动上传）：`);
    console.log(`- 安装包: ${setupPath}`);
    console.log(`- 绿色包: ${zipPath}`);
    console.log(`- 校验和: ${sumsPath}`);
    console.log(`\n安装并登录 GitHub CLI 后，可手动执行：`);
    console.log(
      `  gh release create ${tag} "${setupPath}" "${zipPath}" "${sumsPath}" --title "nexus-mcp ${tag}"${publish ? "" : " --draft"}`,
    );
    return;
  }

  step(`调用 gh 创建 GitHub Release（${publish ? "正式发布" : "Draft 草稿"}）`);
  const out = runGh(ghArgs, root);
  if (out.trim()) console.log(out.trim());
  console.log(`\n完成：${tag}（${publish ? "已发布" : "Draft 草稿，请在 GitHub 网页核对后点击 Publish"}）`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
