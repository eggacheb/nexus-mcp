/**
 * npm run check 全绿后记录当前干净工作区的 HEAD 到 .git/last-check-ok，
 * 供 scripts/hooks/pre-push 在紧接推送同一 commit 时跳过重复的全量检查。
 * 若工作区存在未提交改动，则主动删除旧印记，绝不误放行未测改动。
 */
import { execFileSync } from "node:child_process";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

try {
  const gitDir = execFileSync("git", ["rev-parse", "--git-dir"], { encoding: "utf8", stdio: "pipe" }).trim();
  const stampFile = path.resolve(gitDir, "last-check-ok");
  const dirty = execFileSync("git", ["status", "--porcelain"], { encoding: "utf8", stdio: "pipe" }).trim();
  if (dirty) {
    if (existsSync(stampFile)) rmSync(stampFile, { force: true });
    process.exit(0);
  }
  const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", stdio: "pipe" }).trim();
  writeFileSync(stampFile, `${head}\n`, "utf8");
} catch {
  // 非 git 目录或 git 不可用时静默跳过，不影响 npm run check 退出码
}
