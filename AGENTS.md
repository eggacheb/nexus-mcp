# nexus-mcp

给云端 AI（Gemini 自定义 MCP、ChatGPT 连接器）用的本地 MCP 服务，暴露 8 个工具：
`read` / `write` / `edit` / `bash` / `glob` / `grep` / `job_start` / `job_output`。

目标读者是模型，不是人：工具描述要短、参数要少、返回要能直接读懂。

## 目录

- `src/` — TypeScript 侧：MCP 协议、工具定义、HTTP 传输、面板、执行器协议客户端（`executor.ts`）
- `crates/executor/` — Rust 执行器：唯一的命令执行层，stdio 单行 JSON 协议，`bash` 已接入
- `scripts/` — 自检与本地 CI

## 命令

原样抄自 `package.json`，改动前先看那里：

- 类型检查：`npm run typecheck`
- 编译：`npm run build`（先 `cargo build --release` 构建执行器，再 `tsc`）
- 测试：`npm run test`（vitest，测试只走 MCP 客户端入口）；Rust 侧单独跑 `npm run test:rs`
- 自检：`npm run smoke`（起服务、列出工具、调一次 `read`）
- 本地 CI：`npm run check`（build + vitest + cargo test + smoke，提交前必须全部通过）
- 提交钩子：`git config core.hooksPath scripts/hooks`（克隆后执行一次；pre-commit 拦构建产物进暂存区）

## 不能碰

- **不要启用 GitHub Actions**。CI 全部在本地跑。推送 workflow 文件有账号风险，这条不要绕过。
- **`bash` 工具默认走 Git Bash**（`C:\Program Files\Git\bin\bash.exe`）。PowerShell 只在配置里显式指定时使用，且必须是 PowerShell 7，5.1 的编码问题别去碰。

## 约定

- 工具输出与子进程一律强制 UTF-8：Git Bash 设 `LANG=zh_CN.UTF-8`、`LC_ALL=C.UTF-8`、`MSYS_NO_PATHCONV=1`；pwsh 7 设 `[Console]::OutputEncoding`。
- 路径一律相对沙箱根目录解析，越界直接报错，不做「尽力而为」的修补。
- 工具描述写给人看，不带治理元数据，不出现 `providerId`、`rpcMethod`、`safetyClassification` 这类字段。
- 新增工具先写失败的测试再写实现，不从实现反推测试。

## 复用 codex 代码的规则

移植任何算法前，先读 `docs/research/codex-reusable-parts.md` 和 `docs/research/opencode-reusable-parts.md`（后者是 opencode 侧的对位调研，MIT 无 NOTICE 负担，同样只读参考、不在该目录构建）。

源码在本机 `D:\code\Nexus\cankaoproject\codex\codex-rs`，**只读参考，不要在那个目录里执行 `cargo build`**：它的 workspace 有 6 条 `[patch.crates-io]` 指向 git fork，构建会拉一堆外部仓库。

可以直接搬的只有四样：`execpolicy-rules`、`utils/head-tail-buffer`、`utils/string`、`apply-patch` 的匹配算法（后者的文件系统后端要换成自己的接口）。

不要引入 `codex-protocol`，它依赖 `network-proxy`，会拖进 7 个 `rama` 0.3.0-alpha 包。不要搬 `sandboxing`、`linux-sandbox`、`windows-sandbox-rs`、`mxc-sandbox`、`exec-server`、`network-proxy`，体量和平台绑定都不划算。

## Agent skills

### Issue tracker

Issues 与 spec 以 markdown 文件存放在 `.scratch/`。详见 `docs/agents/issue-tracker.md`。

### Domain docs

单上下文：根目录 `GLOSSARY.md` + `docs/adr/`。详见 `docs/agents/domain.md`。
