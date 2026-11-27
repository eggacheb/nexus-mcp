# Agent Ergonomics & Retro Spec

## 背景（来自真实自举使用复盘）

在连续多轮通过 `nexus-mcp` 自身开发、测试、部署本仓库的过程中，暴露出四处反复触发的高频摩擦点：

1. **`job_output(wait_ms=...)` 对持续打印日志的长命令唤醒过勤**：`vitest` / `cargo test` 每 1–2 秒吐出几行日志，200ms 防抖导致单次 50 秒的 `npm run check` 需要 6–7 次串行轮询。增加可选 `wait_for_exit: boolean`（默认 `false`），传 `true` 时在 `wait_ms` 预算内直接等到任务退出或超时再返回，把长构建/测试压缩到 1–2 次调用。
2. **工具输出夹带大量 ANSI 颜色转义码**：`vitest` 等工具在非 TTY 管道下仍输出 `\x1b[...m` 序列，浪费上下文 token 且影响可读性。在 `build_shell_command` 统一注入 `NO_COLOR=1`。
3. **`pre-commit` 钩子漏检 `crates/tray` 且未跑 `clippy`**：原先仅跑 `cargo check --manifest-path crates/executor/Cargo.toml`，把 `tray` 的编译与全仓 clippy 告警留到 `pre-push` 才暴露。升级为 `npm run lint:rs`（增量约 0.5–1.5 秒）。
4. **文档指针同步**：更新 `AGENTS.md` 与 `docs/agents/issue-tracker.md` 消除陈旧描述。
