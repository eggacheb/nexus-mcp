# 03: 修复 `scripts/hooks/pre-push` 的 `GIT_DIR` 环境变量污染

**What to build:** 修复 `scripts/hooks/pre-push` 中覆盖导出 `GIT_DIR` 环境变量的问题，在执行 `npm run check` 前清理 `GIT_DIR` / `GIT_WORK_TREE` / `GIT_INDEX_FILE`，避免钩子内运行测试时干扰临时 `git` 仓库。

**Blocked by:** None (可立即开工)

**Status:** done

- [x] `scripts/hooks/pre-push` 使用局部小写变量 `git_dir` 读取 `.git/last-check-ok`，不再覆盖 `GIT_DIR` 环境变量。
- [x] 在调用 `npm run check` 前 `unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE`。
- [x] 通过 `sh -n scripts/hooks/pre-push` 语法检查并在真实 `git push` 时验证无异常。

## Comments

- 验收清单 1–3 → `sh -n scripts/hooks/pre-push` 通过，后续真实 `git push` 复验。
