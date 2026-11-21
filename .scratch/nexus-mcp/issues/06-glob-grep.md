# 06: `glob` 与 `grep`

**What to build:** AI 先找文件再读内容，而不是把整棵树塞进上下文。`glob` 按通配符返回路径并按最近修改排序，`grep` 按正则返回文件名、行号和该行内容，两者都遵守 `.gitignore`。

**Blocked by:** 03

**Status:** done

- [x] `glob` 返回匹配的路径列表，按修改时间从新到旧
- [x] `glob` 默认遵守 `.gitignore`，不返回 `node_modules`、`dist` 这类目录里的文件
- [x] `glob` 支持指定搜索起点，起点同样受沙箱约束
- [x] `grep` 返回文件名、行号、匹配行内容
- [x] `grep` 支持 `glob` 参数限定文件范围、`ignore_case` 控制大小写
- [x] `grep` 底层调用 ripgrep，不自己实现遍历，未安装 ripgrep 时给出明确提示
- [x] 结果数量超限时截断，并说明「还有更多」
- [x] 无匹配时返回空结果加一句说明，不当作错误
- [x] 二进制文件被跳过，不把乱码塞进结果

**复用来源：** 遍历参数抄 codex `file-search` 里 `WalkBuilder` 的配置（`hidden(false)`、`follow_links(true)`、`require_git(true)`、可关全部 ignore 规则），约 20 行，见 `docs/research/codex-reusable-parts.md` §2.2。**不要**直接用它做 `glob`：那个 crate 是 fzf 式模糊评分排序（`nucleo` 打分），语义不是 glob 精确匹配。ripgrep 的调用组合与二进制保障照抄 opencode：`core/src/ripgrep.ts` 的 args 集（`--no-config --json --no-messages`、`take(limit+1)` 做截断检测、非 UTF-8 行 base64 解码）与 `core/src/ripgrep/binary.ts` 的发现链（PATH → 全局缓存 → 下载 pinned 版本 + SHA-256 校验；Windows 用 System32 自带的 bsdtar 解 zip，避开 GNU tar 读不了 zip 和 ANSI 代码页对中文用户名路径的坑），见 `docs/research/opencode-reusable-parts.md` §1。codex 侧 grep 无可抄（它自己也调外部 rg）。

## Comments

### 2026-11-21 实现（03/05 基础上）

- **决策（用户点头）：rg 二进制接入走完整发现链**（opencode 模式，方案 B）：`NEXUS_MCP_RG` 显式覆盖 → PATH → 全局缓存（`%LOCALAPPDATA%\nexus-mcp\bin`，Unix `~/.cache/nexus-mcp/bin`）→ 下载 pinned 15.1.0 + SHA-256 校验 + System32 bsdtar 解 zip；下载用 System32 自带 curl（零新增 HTTP 依赖，`-fsSL -m 120`）。成功路径进程内缓存，失败不缓存可重试。落地在 `crates/executor/src/ripgrep.rs`。
- **测试钩子**：`NEXUS_MCP_RG` 指定路径；`NEXUS_MCP_RG_SKIP_DOWNLOAD` 非空时跳过缓存与下载、只查 PATH（用来模拟「机器上没有 ripgrep」，见 `tests/glob-grep.test.ts` 的 rg-missing 用例：清空 PATH + 该钩子）。
- **glob**：Rust `ignore` + `globset`（新增依赖 `ignore`/`globset`/`sha2`/`base64`），照 codex WalkBuilder 参数；`hidden(false)` 会放进隐藏条目，故加 `filter_entry` 排除 `.git` 自身（根目录放行）；mtime 排序用有界堆只留最新 N 条，超大目录不囤内存。遍历单线程 `build()`。
- **grep**：执行器 spawn rg，args 照 opencode（`--no-config --json --hidden --no-messages`、`--glob=!**/.git/**`、`--` 分隔 pattern）；读到 max_results+1 条就 kill 进程做截断检测；exit 2 透出 stderr（正则/glob 语法错误）；非 UTF-8 行走 base64 `bytes` 解码；单行 2000 字符截断。二进制文件靠 rg 自身 NUL 检测跳过。
- **展示约定**：结果路径一律相对沙箱根、正斜杠，模型可直接喂给 `read`/`write`；glob/grep 单次上限 100 条（协议 `max_results` 字段，工具 schema 不动，已发布契约未改）；grep 请求协议超时 300s（rg 缺失时现场下载要分钟级）。
- 测试：`tests/glob-grep.test.ts` 10 条（测试 root `git init`，`require_git(true)` 才认 .gitignore）；Rust 单测覆盖 SHA-256 向量、平台映射、显式覆盖报错、env 判定。`npm run check` 全绿。
