# 01: Rust Clippy 清零、HotswapPlan 接口深化与 last-hotswap.json ISO-8601

Status: done
Blocked-by: none

## 验收标准

- `crates/tray/src/hotswap.rs`：`perform_hotswap` 收窄为 3 个参数 `(server_slot, spec, plan: &HotswapPlan<'_>)`；回滚恢复健康检查超时下限为 `plan.health_timeout.max(Duration::from_secs(10))`；消除 `redundant_closure_call`。
- `crates/tray/src/hotswap.rs`：`write_last_hotswap` 写入标准 UTC ISO-8601 时间戳（`YYYY-MM-DDTHH:MM:SSZ`），附带单元测试覆盖纪元、闰年与常规日期。
- `crates/executor/src/{glob_search.rs,grep_search.rs,ripgrep.rs,main.rs,jobs_tests.rs}`：修复全部 clippy 告警。
- `cargo clippy --manifest-path crates/Cargo.toml --all-targets -- -D warnings` 退出码为 `0`。
- `cargo test --manifest-path crates/Cargo.toml` 全绿。
