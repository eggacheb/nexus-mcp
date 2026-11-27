# Architecture & Hardening Spec

## 背景与目标

前两批（`self-hosting-ergonomics` 与 `ergonomics-polish`）已经补齐执行层多路并发、`job_output` 短等待、运行指纹、单文件 `grep` 与尾读 `read`。全仓体检暴露出四处影响长期可维护性与一致性的摩擦点：

1. **Rust Clippy 告警未清零且热切换时间戳不一致**：`cargo clippy --all-targets -- -D warnings` 存在 6 处告警；`perform_hotswap` 参数达 8 个；`crates/tray/src/hotswap.rs` 写入 `last-hotswap.json` 的 `at` 字段是纯 Unix 秒数，与 `scripts/deploy-local.mjs` 的 ISO-8601 不一致；托盘内回滚健康检查未设 10s 下限。
2. **`crates/executor/src/main.rs` 体量达 1184 行**：沙箱路径校验与词法/规范化边界（~310 行）和 JSON-RPC 调度、文件读写、命令执行混在同一文件，局部性弱。
3. **`src/panel.ts` 体量达 1448 行**：720 行纯前端 HTML/CSS/JS 模板直接内联在后端路由文件顶部，改动后端路由或前端样式都要跨越整屏噪声。
4. **`npm run check` 缺少 `cargo clippy` 门禁**：新引入的 Rust 告警无法在提交/推送前自动拦下。

## 设计原则

- 严格遵守 `codebase-design` 深模块原则：对外暴露小接口，内部细节收敛在模块内，不引入多余透传层。
- 严格零外部行为破坏：所有现有 HTTP 路由、MCP 工具契约、托盘控制接口与测试保持 100% 兼容。
- 不新增第三方 Rust/npm 依赖（UTC ISO-8601 格式化用纯 Rust 无依赖算法实现并配单测）。

## 范围与垂直切片

1. **票 01**：Rust `cargo clippy --all-targets -- -D warnings` 清零 + `HotswapPlan` 深化 `perform_hotswap` + `last-hotswap.json` 统一 ISO-8601 + 回滚超时下限 10s。
2. **票 02**：从 `crates/executor/src/main.rs` 拆出深模块 `crates/executor/src/sandbox.rs`。
3. **票 03**：从 `src/panel.ts` 拆出纯前端模板模块 `src/panelPage.ts`。
4. **票 04**：`package.json` 增加 `lint:rs` 并接入 `npm run check`，同步更新 `AGENTS.md`。
