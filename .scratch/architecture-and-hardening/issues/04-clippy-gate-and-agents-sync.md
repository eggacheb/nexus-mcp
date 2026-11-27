# 04: package.json 接入 lint:rs 到 check 门禁并同步 AGENTS.md

Status: done
Blocked-by: 01, 02, 03

## 验收标准

- `package.json` 新增 `"lint:rs": "cargo clippy --manifest-path crates/Cargo.toml --all-targets -- -D warnings"` 并串联进 `npm run check`。
- `AGENTS.md` 同步反映 `lint:rs` 门禁、`crates/executor/src/sandbox.rs` 与 `src/panelPage.ts` 的新落点。
- 全量 `npm.cmd run check` 退出码 `0`。
