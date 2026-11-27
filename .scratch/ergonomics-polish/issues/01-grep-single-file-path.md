# 01: `grep` 支持单文件路径起点

**What to build:** 让 `grep` 的 `path` 参数既支持目录也支持**沙箱根**内的单个普通文件，一步到位搜索指定大文件内的匹配行，并继续严格守住**沙箱根**双道越界校验。

**Blocked by:** None (可立即开工)

**Status:** done

- [x] `grep` 的 `path` 指向**沙箱根**内单个普通文件时，返回该文件内所有匹配行，且输出路径仍为相对**沙箱根**的正斜杠路径（如 `src/app.ts:3: ...`）。
- [x] `grep` 的 `path` 指向不存在路径、越界路径或指向**沙箱根**外的符号链接时仍被明确拒绝；`glob` 传文件仍保持目录校验不变。
- [x] 更新 `grep` 工具 `path` 参数说明（支持目录或单文件）。
- [x] 通过 Rust 单元测试（`crates/executor/src/main_tests.rs`）与 MCP 客户端测试（`tests/glob-grep.test.ts`）验收单文件搜索、大小写开关与越界拒绝。

## Comments

- 验收清单 1–4 → `tests/glob-grep.test.ts > glob/grep 工具 > grep 的 path 支持直接传单文件路径，并返回相对沙箱根路径`（12/12 通过）
