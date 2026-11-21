/**
 * 打发布包：Node SEA 单文件 exe + 执行器 + 启动脚本 + 说明，收成 zip，再用 NSIS 做安装包。
 *
 * 前置：`npm run build` 过（dist/index.js 与 crates/target/release/nexus-executor.exe 都在）。
 * 用法：`npm run package`。NSIS 首次会从 Tauri 的发布地址取 3.11 的 zip（校验 SHA-256 后才用），
 * 已有解压好的可设 NEXUS_NSIS_DIR 指过去，跳过下载。
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { VERSION } from "../src/version.js";

// 打包工具要走系统代理取 NSIS；Node 24 的 fetch 默认不认 HTTPS_PROXY
process.env.NODE_USE_ENV_PROXY = process.env.NODE_USE_ENV_PROXY ?? "1";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, "..");
const buildDir = path.join(root, "build");
const stageDir = path.join(buildDir, "package");
const seaDir = path.join(buildDir, "sea");
const releaseDir = path.join(root, "release");

const APP_NAME = "nexus-mcp";
const EXECUTOR = "nexus-executor.exe";
const START_SCRIPT = "启动.cmd";
const GUIDE = "使用说明.txt";
const ZIP_NAME = `${APP_NAME}-${VERSION}-win64.zip`;
const SETUP_NAME = `${APP_NAME}_${VERSION}_x64-setup.exe`;

// Tauri bundler 用的就是这份 NSIS，固定版本 + 校验和，不让工具链随上游漂
const NSIS_URL =
  "https://github.com/tauri-apps/binary-releases/releases/download/nsis-3.11/nsis-3.11.zip";
const NSIS_SHA256 = "c7d27f780ddb6cffb4730138cd1591e841f4b7edb155856901cdf5f214394fa1";

function step(message: string): void {
  console.log(`\n== ${message}`);
}

function fail(message: string): never {
  console.error(`\n打包失败：${message}`);
  process.exit(1);
}

function requireFile(file: string, hint: string): void {
  if (!existsSync(file)) fail(`缺少 ${file}。${hint}`);
}

/** 取 NSIS：优先用 NEXUS_NSIS_DIR，其次下载校验后解压到 build/tools */
async function ensureNsis(): Promise<string> {
  const fromEnv = process.env.NEXUS_NSIS_DIR?.trim();
  if (fromEnv) {
    const exe = path.join(fromEnv, "makensis.exe");
    if (existsSync(exe)) return exe;
    fail(`NEXUS_NSIS_DIR 指向的目录里没有 makensis.exe: ${fromEnv}`);
  }

  const nsisRoot = path.join(buildDir, "tools", "nsis", "nsis-3.11");
  const makensis = path.join(nsisRoot, "makensis.exe");
  if (existsSync(makensis)) return makensis;

  const toolsDir = path.join(buildDir, "tools");
  const zipPath = path.join(toolsDir, "nsis-3.11.zip");
  mkdirSync(toolsDir, { recursive: true });

  step("下载 NSIS 3.11（Tauri bundler 同款）");
  const response = await fetch(NSIS_URL);
  if (!response.ok) fail(`下载 NSIS 失败：HTTP ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  const digest = createHash("sha256").update(buffer).digest("hex");
  if (digest !== NSIS_SHA256) fail(`NSIS 压缩包校验和不符：${digest}`);
  writeFileSync(zipPath, buffer);

  step("解压 NSIS");
  // System32 的 bsdtar 能直接读 zip，不依赖外部解压工具
  execFileSync(path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe"), [
    "-xf",
    zipPath,
    "-C",
    path.join(toolsDir, "nsis"),
  ], { stdio: "inherit" });

  if (!existsSync(makensis)) fail(`解压后仍找不到 makensis.exe: ${makensis}`);
  return makensis;
}

/** 把 dist 打成单个 CJS 文件：SEA 只认 CJS 入口 */
async function bundleToCjs(): Promise<string> {
  step("打包 TypeScript 产物为单个 CJS 文件");
  const outfile = path.join(seaDir, "app.cjs");
  await build({
    entryPoints: [path.join(root, "dist", "index.js")],
    outfile,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node24",
    legalComments: "none",
    logLevel: "warning",
  });
  return outfile;
}

/** 生成 SEA blob 并注入 node.exe 副本，产出 nexus-mcp.exe */
async function buildSingleExe(bundle: string): Promise<string> {
  step("生成 SEA blob");
  const blob = path.join(seaDir, "sea-prep.blob");
  const seaConfig = path.join(seaDir, "sea-config.json");
  writeFileSync(
    seaConfig,
    `${JSON.stringify(
      { main: bundle, output: blob, disableExperimentalSEAWarning: true, useCodeCache: false },
      null,
      2,
    )}\n`,
    "utf8",
  );
  execFileSync(process.execPath, ["--experimental-sea-config", seaConfig], { stdio: "inherit" });
  requireFile(blob, "SEA blob 没有生成，当前 Node 可能不支持 SEA。");

  step("注入 blob，产出 nexus-mcp.exe");
  const exePath = path.join(stageDir, `${APP_NAME}.exe`);
  copyFileSync(process.execPath, exePath);

  const { inject } = await import("postject");
  await inject(exePath, "NODE_SEA_BLOB", readFileSync(blob), {
    sentinelFuse: "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
  });
  return exePath;
}

function writeRuntimeFiles(): void {
  step("写启动脚本与说明");
  // chcp 65001 保证 cmd 窗口里的中文日志不乱码；--open-panel 由程序自己拉面板
  writeFileSync(
    path.join(stageDir, START_SCRIPT),
    [
      "@echo off",
      "chcp 65001 > nul",
      'cd /d "%~dp0"',
      "echo nexus-mcp 启动中，控制面板稍后自动打开……",
      `${APP_NAME}.exe --open-panel`,
      "if errorlevel 1 pause",
      "",
    ].join("\r\n"),
    "utf8",
  );

  writeFileSync(
    path.join(stageDir, GUIDE),
    [
      `${APP_NAME} ${VERSION} —— 三步上手`,
      "",
      `1. 双击「${START_SCRIPT}」，等控制面板在浏览器里打开。`,
      "2. 面板「MCP 地址」就是云端要填的地址；令牌在安装目录 config.json 的 token 字段",
      "   （首次启动自动生成，同时打印在启动窗口里）。",
      "3. 把地址和令牌填进 Gemini 自定义 MCP / ChatGPT 连接器，就能调 read / write / edit /",
      "   bash / glob / grep / job_start / job_output / job_kill 这 9 个工具。",
      "",
      "改沙箱根目录：面板「根目录」卡片里改，或直接改 config.json 的 root。默认是 exe 同目录的 workspace。",
      "卸载：设置 → 应用 → nexus-mcp。config.json 与 workspace 不会被删。",
      "",
    ].join("\r\n"),
    "utf8",
  );
}

function zipStage(): string {
  step("打包 zip");
  const zipPath = path.join(releaseDir, ZIP_NAME);
  rmSync(zipPath, { force: true });
  const script = `Compress-Archive -Path '${stageDir}\\*' -DestinationPath '${zipPath}' -Force`;
  // 优先 pwsh 7（UTF-8 行为一致）；机器上只有 5.1 时退回 powershell.exe，
  // 入口文件名由命令行传入（UTF-16），压缩包里中文名不受代码页影响。
  let lastError: unknown;
  for (const shell of ["pwsh", "powershell.exe"]) {
    try {
      execFileSync(shell, ["-NoProfile", "-NonInteractive", "-Command", script], { stdio: "inherit" });
      lastError = undefined;
      break;
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError) throw lastError;
  requireFile(zipPath, "zip 没有生成。");
  return zipPath;
}

function buildInstaller(nsis: string): string {
  step("构建 NSIS 安装包");
  const setupPath = path.join(releaseDir, SETUP_NAME);
  rmSync(setupPath, { force: true });
  execFileSync(
    nsis,
    [
      "/INPUTCHARSET",
      "UTF8",
      `/DAPP_VERSION=${VERSION}`,
      `/DSTAGE_DIR=${stageDir}`,
      `/DOUT_FILE=${setupPath}`,
      path.join(scriptDir, "installer", "nexus-mcp.nsi"),
    ],
    { stdio: "inherit" },
  );
  requireFile(setupPath, "安装包没有生成。");
  return setupPath;
}

async function main(): Promise<void> {
  if (process.platform !== "win32") fail("当前只做 Windows 发布包。");

  requireFile(path.join(root, "dist", "index.js"), "先运行 npm run build。");
  requireFile(path.join(root, "crates", "target", "release", EXECUTOR), "先运行 npm run build。");

  rmSync(stageDir, { recursive: true, force: true });
  rmSync(seaDir, { recursive: true, force: true });
  mkdirSync(stageDir, { recursive: true });
  mkdirSync(seaDir, { recursive: true });
  mkdirSync(releaseDir, { recursive: true });

  const bundle = await bundleToCjs();
  await buildSingleExe(bundle);

  step("拷入执行器");
  copyFileSync(path.join(root, "crates", "target", "release", EXECUTOR), path.join(stageDir, EXECUTOR));

  writeRuntimeFiles();

  const nsis = await ensureNsis();
  const zipPath = zipStage();
  const setupPath = buildInstaller(nsis);

  const mb = (file: string): string => `${(readFileSync(file).length / 1024 / 1024).toFixed(1)}MB`;
  console.log(`\n完成，版本 ${VERSION}`);
  console.log(`- zip:   ${zipPath} (${mb(zipPath)})`);
  console.log(`- 安装包: ${setupPath} (${mb(setupPath)})`);
  console.log(`- 安装包内文件: ${[`${APP_NAME}.exe`, EXECUTOR, START_SCRIPT, GUIDE].join("、")}`);
}

main().catch((error: unknown) => {
  fail((error as Error).message);
});
