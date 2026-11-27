# 02: 拆出 crates/executor/src/sandbox.rs 沙箱路径深模块

Status: done
Blocked-by: 01

## 验收标准

- 新建 `crates/executor/src/sandbox.rs`，完整承接 `SandboxRoot`、`SandboxEntryKind`、`resolve_root`、`open_within_sandbox`、`resolve_existing_within_sandbox`、`resolve_search_dir`、`resolve_grep_target`、`ensure_lexically_within`、`display_path`、`escape_error`、`root_not_writable_error`、`display_rel_prefix` 及私有辅助函数（`Containment`、`classify`、`lexical_normalize`）。
- `crates/executor/src/main.rs` 移除重复路径校验实现，经 `mod sandbox;` 调用，行数下降约 300 行。
- `cargo clippy --manifest-path crates/Cargo.toml --all-targets -- -D warnings` 与 `cargo test --manifest-path crates/Cargo.toml` 全绿。
