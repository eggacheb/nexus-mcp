# nexus-mcp

给云端 AI（Gemini 自定义 MCP、ChatGPT 连接器）用的本地 MCP 服务，暴露 9 个工具：
`read` / `write` / `edit` / `bash` / `glob` / `grep` / `job_start` / `job_output` / `job_kill`。

目标读者是模型，不是人：工具描述要短、参数要少、返回要能直接读懂。

## 目录

- `src/` — TypeScript 协议层：MCP 协议、工具定义、HTTP 传输、面板、配置与服务日志、执行器客户端（`executor.ts`）
- `crates/executor/` — Rust 执行层：唯一接触沙箱磁盘与子进程的部分，stdio 单行 JSON 协议（rg 缺失时自动下载 pinned 版本到全局缓存，测试钩子见 `crates/executor/src/ripgrep.rs` 头注释）
- `scripts/` — 打包、自检与本地 CI 钩子

## 命令

原样对应 `package.json`：

- 类型检查：`npm run typecheck`
- 编译：`npm run build`（先 `cargo build --release` 构建执行器与托盘宿主，再 `tsc`）
- 最小三件套打包：`npm run package:stage`（产出 `build/package/` 下的 `nexus-mcp.exe` + `nexus-server.exe` + `nexus-executor.exe`，跳过 NSIS）
- 本地一键发布：`npm run release [-- <semver>] [--publish]`（同步版本号 → `check` → `package` + `package:smoke` → `release/SHA256SUMS.txt` → 本机 `gh release create`，默认 Draft，不触碰 GitHub Actions）
- 本机一键热切换：`node scripts/deploy-local.mjs`（最小打包 → 临时端口 `package:smoke` → 按 `nexus-mcp.exe` 哈希走托盘内无缝换核或脱离进程树切换，保隧道不断、10 秒 `/health` 失败自动回滚，零改动 `config.json` 与 `oauth-store.json`）
- 拉取服务日志：`GET http://127.0.0.1:8788/api/logs`（面板自带接口，返回 JSON `{ lines }`，含最近 200 行已脱敏的服务日志，排查运行期问题可直接请求）
- 测试：`npm run test`（vitest，跨组件验收一律走 MCP 客户端入口）；Rust 侧单独跑 `npm run test:rs`
- 自检：`npm run smoke`（起服务、列出工具、调一次 `read`）
- 本地 CI：`npm run check`（build + vitest + cargo test + smoke，提交推送前必须全部通过）
- 提交钩子：`git config core.hooksPath scripts/hooks`（克隆后执行一次）。`pre-commit` 拦构建产物与常见测试陷阱 + 快速检查（`typecheck` + `cargo check`）；`pre-push` 跑全量 `npm run check`，别用 `--no-verify` 绕过。
- **通过本服务自举执行时**：Git Bash 设了 `MSYS_NO_PATHCONV=1`，调 pnpm 下的 npm 脚本统一写 `npm.cmd`（如 `npm.cmd run build`、`npm.cmd run check`），单文件测试跑 `./node_modules/.bin/vitest run --pool=vmThreads <file>`；构建、全量测试与 `cargo` 等长命令一律走 `job_start` / `job_output`。

## 不能碰

- **不要启用 GitHub Actions**。CI 全部在本地跑，推送 workflow 文件有账号风险。
- **不要读取或打印仓库根的 `config.json`**（含本机部署令牌与私有路径）；未经明确同意不执行 `git commit` / `git push` 或修改 git 配置。
- **`bash` 工具默认走 Git Bash**（`C:\Program Files\Git\bin\bash.exe`）。PowerShell 只在配置显式指定时使用，且必须是 PowerShell 7，不碰 5.1。
- **本机自举连接保护**：若宿主机正运行 `npm run dev`（占用 `8787` / `8788`）承载当前 MCP 会话，严禁杀 `8787`/`8788` 进程；`cargo build --release` 若因旧执行器占用报 `os error 5`，将 `crates/target/release/nexus-executor.exe` 原地 `mv` 为 `nexus-executor.running.exe` 即可解锁重编。用户刚重启本服务后的首轮先发单条只读调用完成新会话握手，再并发扇出。

## 约定

- 工具输出与子进程一律强制 UTF-8：Git Bash 设 `LANG=zh_CN.UTF-8`、`LC_ALL=C.UTF-8`、`MSYS_NO_PATHCONV=1`；pwsh 7 设 `[Console]::OutputEncoding`。`tasklist`/`taskkill` 这类只做 ASCII 匹配的系统工具除外。
- 本机出网走系统代理（`HTTPS_PROXY` 等）。Node 24 的 `fetch` 默认忽略代理环境变量：需要公网请求的代码开 `NODE_USE_ENV_PROXY=1`（`src/index.ts` 已开），别裸写直连探测。
- 测试不得依赖机器状态：stdio 测试必须显式传 `NEXUS_MCP_CONFIG` 隔离配置，隧道用例用 `NEXUS_TUNNEL_EXTERNAL=off` / `isRunningExternal` 桩与真隧道隔离。
- 面板状态灯只读本地信号：隧道看 `127.0.0.1:20241/ready` 的 `readyConnections`，不拿公网往返驱动颜色（详见 `docs/tunnel.md`）。
- 路径一律相对沙箱根解析，越界直接报错，不做静默裁剪；工具描述简洁直观，不带 `providerId`、`rpcMethod`、`safetyClassification` 等治理元数据。
- 日志与 `stderr` 严守脱敏边界：绝不输出令牌、密码、文件/补丁正文或 `"Authorization"`（不区分大小写，`tests/http.test.ts` 有强断言）字样。
- 先红后绿：新增能力或修 bug 先写失败测试亲眼确认变红，再写最小实现；改完 `src/` 或 Rust 后必须先构建再跑 vitest（HTTP/stdio 测试均拉起真实的 `dist/index.js`）。
- `cargo test` 中真实 spawn 子进程的用例在模块内串行（照 `jobs_tests.rs` 的 `SPAWN_LOCK`）；vitest 固定走 `--pool=vmThreads`，跨 realm 异常只断言 `message` 内容，禁用 `.toBeInstanceOf(Error)`。
- 票据完成后在票面 `## Comments` 逐条注明验收清单对应的测试用例。
- 新增或调整底层算法前：先读 `docs/adr/0007-command-policy-reuse-opencode-wildcard.md` 与 `docs/research/{codex,opencode}-reusable-parts.md`；本机参考仓 `cankaoproject/` 严格只读、禁止在其中执行构建。

## Agent skills

- **Issue tracker**：Issues 与 spec 以本地 Markdown 存放在 `.scratch/nexus-mcp/`，详见 `docs/agents/issue-tracker.md`。
- **Domain docs**：单上下文，根目录 `GLOSSARY.md` + `docs/adr/`，详见 `docs/agents/domain.md`。
