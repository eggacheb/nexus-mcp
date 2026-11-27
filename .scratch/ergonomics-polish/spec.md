# 自举调试体验打磨（第二批） 规格

Status: ready-for-agent

## Problem Statement

在完成第一批自举流畅度优化并实机运行后，仍有 4 处高频小摩擦值得收口：

1. **`grep` 传单文件路径报错**：模型定位大文件内的符号时常直接传单文件路径给 `grep`，但当前执行层仅接受目录起点，被迫改传父目录加 `glob` 重试。
2. **`read` 不支持负 `offset` 尾读**：查看大日志或大测试文件末尾时，不知道总行数必须先读一次拿 `total_lines` 再算偏移。
3. **`scripts/hooks/pre-push` 环境变量污染**：钩子中给 `GIT_DIR` 赋值且未清理 `GIT_DIR` / `GIT_WORK_TREE` / `GIT_INDEX_FILE`，在钩子触发 `npm run check` 时可能干扰测试内临时 `git` 仓库。
4. **面板 UI 未展示运行指纹与热切换状态、`AGENTS.md` 仍停留在上一版能力**：后端 `/api/status` 已返回 `buildId`、`startedAt`、`pid` 与 `lastHotswap`，但面板页头尚未渲染；`AGENTS.md` 也需同步最新能力描述。

## Solution

继续严格保持 9 个 MCP 工具不变，通过 4 张垂直切片小票逐项收口：

1. **`grep` 支持单文件路径起点**：`path` 指向**沙箱根**内普通文件时直接对该文件执行 `ripgrep`，返回相对**沙箱根**正斜杠路径、行号与行内容；指向越界路径或符号链接指向根外仍严格拒绝。
2. **`read` 支持负 `offset` 尾读**：`offset < 0` 表示从文件末尾倒数（如 `offset = -80` 表示从最后 80 行的首行开始读，超出总行数时自动钳制到第 1 行），保持真实 1-based 行号与既有字节上限截断提示。
3. **修复 `scripts/hooks/pre-push` 环境变量污染**：用局部小写变量 `git_dir` 并在调用 `npm run check` 前 `unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE`。
4. **面板 UI 展示 `buildId` / `lastHotswap` 并同步 `AGENTS.md`**：面板页头展示 `v<version> · <buildId>` 与最近一次**热切换**摘要（若有），并把 `AGENTS.md` 同步到最新能力（`write` 自动建父目录、`job_output.wait_ms`、`grep` 单文件、`read` 尾读、`/api/hotswap`、`/api/logs` 过滤）。

## Testing Decisions

继续沿用仓库既有公开测试缝隙：
- MCP 客户端工具入口：`tests/glob-grep.test.ts`、`tests/read-write.test.ts`
- Rust 执行层单元测试：`crates/executor/src/main_tests.rs`
- 面板与前端脚本解析：`tests/panel.test.ts`

## Out of Scope

- 不改变 `glob` 必须传目录起点的语义。
- 不改变 `read` 的 `offset = 0`（仍按参数校验拒绝，仅允许正整数或负整数）。
- 不新增 MCP 工具或引入外部依赖。
