# 02: `read` 支持负 `offset` 尾读

**What to build:** 让 `read` 的 `offset` 支持负整数（如 `offset: -50` 表示从文件末尾倒数第 50 行开始读），避免查看大文件或日志末尾时必须先多读一次拿总行数。

**Blocked by:** None (可立即开工)

**Status:** done

- [x] `read` 传入负整数 `offset`（如 `-3`）时，从文件倒数第 `|offset|` 行开始读取并保留真实 1-based 行号；当 `|offset| >= total_lines` 时从第 1 行开始读；空文件仍返回空文件提示。
- [x] `read` 传入 `offset: 0` 被参数校验明确拒绝（避免歧义），正整数 `offset` 行为 100% 向后兼容；`limit` 与字节上限截断逻辑在负 `offset` 下同样生效。
- [x] 更新 `read` 工具 `offset` 参数说明。
- [x] 通过 Rust 单元测试（`crates/executor/src/main_tests.rs`）与 MCP 客户端测试（`tests/read-write.test.ts`）验收负偏移尾读、超大负偏移钳制、负偏移配合 `limit` 及 `offset=0` 拒绝。

## Comments

- 验收清单 1–4 → `crates/executor/src/main_tests.rs > read_op_negative_offset_reads_tail_and_rejects_zero`、`tests/read-write.test.ts > read/write 工具 > read 支持负 offset 尾读，保留真实行号并钳制超大负偏移，拒绝 offset=0`（13/13 通过）
