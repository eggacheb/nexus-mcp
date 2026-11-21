# codex-rs 可复用组件调研

调研对象：`cankaoproject/codex/codex-rs`（下文路径均相对于该目录）
目标：为「8 工具本地 MCP server（read/write/edit/bash/glob/grep/job_start/job_output）」找可以搬走的现成实现。

---

## 结论摘要

1. workspace 共 **179 个 crate**（180 个 `Cargo.toml` 含根）。agent 层只有一个锚点：**`core`（`core/src/client.rs:356` 的 `ModelClient`）**；凡是 `Cargo.toml` 里出现 `codex-core` / `codex-model-provider` / `codex-login` 的即为 agent 层，其余为基础设施。
2. **`codex-protocol` 不是纯类型 crate**——它依赖 `codex-network-proxy`（`protocol/Cargo.toml:22`）→ 拉进 `rama-*` alpha、`aws-sigv4`、`opentelemetry`。任何 `depends on protocol` 的 crate 都隐性背上整套网络代理栈。这是本次调研最重要的分界线。
3. 唯一「零成本直接搬」的候选是 **`execpolicy-rules`**（7 个轻量依赖）和 **`utils/head-tail-buffer`**（**零依赖**）、**`utils/string`**（`regex-lite`+`serde`）。
4. **`apply-patch` 现在是重依赖**：`apply-patch/Cargo.toml:21` 依赖 `codex-exec-server`，间接拖进 `codex-config`(tonic/prost)、`codex-api`(tungstenite/rustls)、`codex-otel`、`codex-network-proxy`(rama)。**它的 patch 解析/模糊匹配算法仍值得抄**（`parser.rs` + `seek_sequence.rs`），但必须把 `ExecutorFileSystem` 换成自己的 FS 层。
5. `file-search` 依赖干净（`ignore` + `nucleo` + `clap`），但它是 **fzf 式模糊文件名评分**，不是 glob 语义，直接当 `glob` 工具用会错。
6. `shell-command` **不是 bash 执行器**——没有进程派生、没有 PTY，只有命令解析 + 危险命令判定 + shell snapshot；且依赖 protocol。
7. `message-board-mcp` 里 `serve_http()`（`src/http.rs:43-105`）是 **streamable HTTP + Bearer + host 校验 + 优雅关闭 + session 排空** 的完整可抄范式，约 100 行，但它所在的 crate 本身绑死 `message-board`/`state`(sqlx)/`tools`。
8. `sandboxing` / `linux-sandbox` / `windows-sandbox-rs` / `mxc-sandbox` / `network-proxy` / `exec-server` 全部放弃：体量、平台绑定、依赖链都不划算。
9. 官方 Release **有 `codex-exec-server` 预编译二进制**（含 Windows msvc），但**没有** `apply_patch` / `codex-file-search` 独立产物；npm `@openai/codex` 只发 `bin/codex.js`。
10. 许可证 **Apache-2.0**，但**带一个 NOTICE**（OpenAI 版权 + Ratatui MIT 归属），搬运时必须一并保留。

---

## 总表

| crate | 能否独立（无 core/模型依赖） | Windows | 依赖重量 | 建议 |
|---|---|---|---|---|
| `apply-patch` | 否，依赖 `codex-exec-server` | 可以 | 重（含 rama/tonic/tungstenite） | **抽出来改**（保留 parser 算法，换掉 FS trait） |
| `file-search` | 可以，完全独立 | 可以，有 `cfg(windows)` 分支 | 轻（`ignore`/`nucleo`/`clap`） | **直接搬 lib**，但只用于文件名检索 |
| `shell-command` | 依赖 `codex-protocol`（非 core） | 可以，有 powershell 全套 | 中重（protocol 链 + 3×tree-sitter） | **只当参考 / 抽单文件** |
| `execpolicy-rules` | 可以，完全独立 | 可以 | 轻（7 个） | **直接搬**（本仓库最佳候选） |
| `execpolicy` | 无 core | 可以 | 中（+ `starlark` 0.14） | **直接搬**（若要 Starlark 规则文件） |
| `sandboxing` | 无 core，但依赖 protocol/network-proxy/mxc | 有 windows 模块 | 重 | **放弃**（仅参考 manager 抽象） |
| `linux-sandbox` | 无 core | 不适用（`cfg(target_os="linux")`） | 重（landlock/seccomp/smoltcp） | **放弃** |
| `windows-sandbox-rs` | 无 core | 可以，但需 MSVC + 服务 + 两个 helper exe | 极重（118 个源文件） | **放弃** |
| `mxc-sandbox` | 无 core，依赖 protocol/network-proxy | 实质 Windows-only | 重（`mxc-sdk` git 依赖） | **放弃** |
| `exec-server` | 无 core / 无 ModelClient | 可以 | 极重（166 个源文件） | **只当参考**（job 事件模型） |
| `exec-server-protocol` | 依赖 protocol/network-proxy/shell-command | 可以 | 中重 | **只当参考** |
| `exec-server-cli` | 依赖 `codex-core` + `codex-model-provider` | 可以 | 极重 | **放弃**（用官方预编译二进制代替） |
| `message-board-mcp` | 依赖 protocol/tools/state(sqlx) | 可以 | 重 | **只当参考**（抄 `http.rs`） |
| `tcp-tunnel` | 零 codex 依赖 | 可以 | 中（h3/quinn/rustls） | **放弃**（用途无关） |
| `network-proxy` | 零 codex 依赖 | 可以，有 windows 模块 | 重（`rama` 0.3.0-alpha.4 ×7） | **放弃** |
| `utils/head-tail-buffer` | 零依赖 | 可以 | 极轻 | **直接搬**（job_output 就缺这个） |
| `utils/string` | 可以 | 可以 | 轻 | **直接搬**（`take_bytes_at_char_boundary`） |

---

## 1. Workspace 总览与「agent 层 vs 基础设施」的分界依据

### 1.1 结构

- 根 `Cargo.toml:2-177` 的 `members` 列表 **174 条**，其中 4 条是测试支持包：`exec-server/tests/support`(:66)、`protocol/tests/support`(:109)、`thread-context-ids/tests/support`(:171)、`windows-sandbox-rs/tests/support`(:129)。
- 全仓 `Cargo.toml` 共 **180 个**（含根），即 **179 个 crate**。
- 统一 `edition = "2024"`、`version = "0.0.0"`、`license = "Apache-2.0"`（`Cargo.toml:180-187`）。
- 内部 crate 命名映射集中在 `Cargo.toml:189-356`；外部依赖版本集中在 `Cargo.toml:358-607`。
- **关键构建事实**：`Cargo.toml:691-707` 有 6 条 `[patch.crates-io]`，全部指向 git fork：`crossterm`(openai-oss-forks)、`sqlx-core`/`sqlx-sqlite`(transact-rs)、`tokio-tungstenite`/`tungstenite`(openai-oss-forks)、`v8`(openai-oss-forks/rusty_v8)。任何在此 workspace 内 build 都会拉这些 git 仓库。

### 1.2 分界依据（不靠猜）

**唯一判定标准：`Cargo.toml` 的 `[dependencies]` 里有没有这三个之一。**

| 标记 crate | 性质 | 证据 |
|---|---|---|
| `codex-core` | agent 层本体 | `core/src/client.rs:356` `pub struct ModelClient` 是全仓唯一 ModelClient 定义 |
| `codex-model-provider` / `model-provider` | 模型供应商抽象 | `Cargo.toml:293` |
| `codex-login` / `login` | 账号鉴权 | `Cargo.toml:276` |

抽查结果：

- `exec-server/Cargo.toml:21-95`：**没有** `codex-core` → exec-server 属基础设施。但它依赖 `codex-config`(:30)、`codex-api`(:28)、`codex-otel`(:37)、`codex-protocol`(:38)，所以「无 agent 层」不等于「轻」。
- `exec-server-cli/Cargo.toml:27,31`：**有** `codex-core` 和 `codex-model-provider` → agent 层。同一个功能，lib 和 cli 分属两侧。
- `sandboxing`、`network-proxy`、`linux-sandbox`、`windows-sandbox-rs`、`mxc-sandbox`、`apply-patch`、`file-search`、`execpolicy*`、`shell-command`、`tcp-tunnel`、`message-board-mcp`：**均无** `codex-core` 依赖（逐个核过 Cargo.toml）。

### 1.3 隐性重依赖：`codex-protocol` 不是「纯类型」

这是最容易踩的坑。`protocol/Cargo.toml`：

- `:22` `codex-network-proxy` ← **最大污染源**
- `:21` `codex-http-client` → `http-client/Cargo.toml:14,16,35`：`native-tls`、`reqwest`(rustls+zstd+gzip)、Windows 上 `curl`(static-curl)+`rustls-platform-verifier
- `:20` `codex-extension-items`、`:19` `codex-execpolicy-rules`
- `:31` `gix-url`、`:34-36` `icu_decimal`/`icu_locale_core`/`icu_provider`（ICU 数据）、`:48` `ts-rs`、`:38` `schemars`

而 `network-proxy/Cargo.toml:47-53` 是 7 个 `rama-* = "=0.3.0-alpha.4"`（alpha 版本）+ `:21-22` `aws-credential-types`/`aws-sigv4` + `:31` `opentelemetry`。

**推论：`shell-command`、`file-system`、`exec-server-protocol`、`sandboxing`、`apply-patch`(经 exec-server) 全部隐性背上 rama + aws + otel + reqwest。** 这是「不能直接搬」的真正原因，比「有没有 codex-core」更致命。

---

## 2. 逐个 crate 评估

### 2.1 `apply-patch` → 我们的 `edit`

- **crate 名**：`codex-apply-patch`
- **对外暴露**：lib `codex_apply_patch`（`Cargo.toml:7-10`）+ bin `apply_patch`（`:12-14`，`src/main.rs` 只有 3 行，直接转调 lib 的 `main`）。
  pub API（`src/lib.rs:24-41`）：`parse_patch`、`Hunk`、`UpdateFileChunk`、`StreamingPatchParser`、`maybe_parse_apply_patch`、`maybe_parse_apply_patch_verified`、`verify_apply_patch_args`、`ApplyPatchOptions`、`ApplyPatchError`、`unified_diff_from_chunks*`、`ApplyPatchFileUpdate`。
  常量 `CODEX_CORE_APPLY_PATCH_ARG1 = "--codex-run-as-apply-patch"`（`src/lib.rs:52`）。
- **有没有 codex-core / 模型 crate**：**有 `codex-exec-server`**（`Cargo.toml:21`）。虽然 exec-server 本身无 core，但它 → `codex-config`(tonic/prost) + `codex-api`(tungstenite) + `codex-otel` + `codex-network-proxy`(rama)。**结论：按原样不可直接搬。**
- **重量级第三方**：`tree-sitter` + `tree-sitter-bash`（C 代码，需 cc）、`similar`、`tokio`。加上 exec-server 链条后是重。
- **Windows**：可以，无任何 `cfg` 平台排除。src 里 10 个文件（`lib.rs` 46 KB、`invocation.rs` 32 KB、`streaming_parser.rs` 35 KB、`parser.rs` 22.7 KB、`file_update.rs` 7.8 KB、`seek_sequence.rs` 5.9 KB、`text_file.rs` 3.9 KB）。`tree-sitter-bash` 跨平台；只在 arg0 侧有 `apply_patch.bat` 的 Windows 特例（`arg0/src/lib.rs:398-405`），与本 crate 无关。
- **建议：抽出来改。**
  真正值钱的是模糊上下文匹配算法：`parser.rs:26-31` 只依赖 `crate::ApplyPatchArgs` + `streaming_parser` + `PathUri`，**不含 exec-server**；`seek_sequence.rs`、`text_file.rs` 同理。
  只有 `file_update.rs:1-4` 依赖 `ExecutorFileSystem` / `FileSystemSandboxContext` / `ReadFileOptions` / `PathUri`，且 `invocation.rs:150-153` 的签名把 `&dyn ExecutorFileSystem` 当参数。
  **改造量**：把这 4 个类型换成一个约 10 方法的自有 FS trait（read/write/remove/create_dir/get_metadata/canonicalize），其余约 5 个文件原样保留。这比自己从零写 unified-diff 模糊应用靠谱得多。

### 2.2 `file-search` → 我们的 `glob` / `grep`（部分）

- **crate 名**：`codex-file-search`
- **对外暴露**：lib + bin 同名（`Cargo.toml:7-14`）。
  pub API（`src/lib.rs`）：`run(pattern, roots, FileSearchOptions, cancel_flag) -> FileSearchResults`（`:309`）、`create_session(...) -> FileSearchSession`（`:176`）、`Cli`（`:41`）、`Reporter`（`:231`）、`SessionReporter`（`:147`）、`FileMatch{score,path,match_type,root,indices}`（`:56-63`）、`MatchType`（`:67-70`）、`FileSearchOptions{limit,exclude,threads,compute_indices,respect_gitignore}`（`:118-131`）、`cmp_by_score_desc_then_path_asc`（`:338`）。
- **有没有 codex-core / 模型 crate**：**完全没有**。`Cargo.toml:19-27` 就 7 个依赖：`anyhow`、`clap`、`crossbeam-channel`、`ignore`、`nucleo`(git)、`serde`、`serde_json`、`tokio`。
- **重量级第三方**：`nucleo` 是 **git 依赖**（`Cargo.toml:454` `helix-editor/nucleo` rev `4253de9f...`）。搬走时要么改指 crates.io 版本，要么 vendor。其余都轻。
- **Windows**：有显式分支（`src/lib.rs:257-274`：`#[cfg(unix)]` 走 `ls -al`，`#[cfg(windows)]` 走 `cmd /c`）。
- **建议：直接搬 lib，但别当 glob 用。**
  它是 **fzf 式模糊评分排序**（用 `nucleo` 打分，`src/lib.rs:544-575`），语义是「给个模糊串，返回打分最高的 N 个文件」。`glob` 工具要的是 glob 模式精确匹配 → 应该用 `globset`（workspace 已有，`Cargo.toml:418`）。
  真正该抄的是它的 walker 配置（`src/lib.rs:458-474`）：`hidden(false)` + `follow_links(true)` + `require_git(true)` + 可关全部 ignore 规则。这段约 20 行，直接把 `ignore::WalkBuilder` 的参数选择抄过来即可。

### 2.3 `shell-command` → 我们的 `bash`

- **crate 名**：`codex-shell-command`（**lib only**，`Cargo.toml:31-32`，无 bin）
- **对外暴露**（`src/lib.rs:1-14`）：
  `pub mod shell_detect` / `shell_snapshot` / `bash` / `parse_command` / `powershell`；
  `pub use startup::shell_startup_script`；`pub use command_safety::is_dangerous_command`。
  **注意：这里没有 `Command::spawn`、没有 PTY、没有沙箱包装。** 它是纯「解析 + 判定 + 快照」库。
- **有没有 codex-core / 模型 crate**：**依赖 `codex-protocol`**（`Cargo.toml:12`）。虽无 core，但 protocol 直接带来 `codex-network-proxy`(rama)。用到的地方：`config_types::ShellEnvironmentPolicy`（`src/shell_snapshot_render.rs:5`）、`shell_environment::create_env_from_vars` / `scrub_non_inheritable_env_vars` / `CODEX_THREAD_ID_ENV_VAR`、`parse_command::ParsedCommand`（`src/parse_command.rs:5`）。
- **重量级第三方**：`tree-sitter` + `tree-sitter-bash` + `tree-sitter-powershell`（**3 个** tree-sitter 语法，都是 C 编译）、`regex`、`which`、`url`、`shlex`、`base64`、`once_cell`。src 共 20 个文件，`parse_command.rs` 单文件 93 KB。
- **Windows**：支持完整。有 `command_safety/powershell_tree_sitter.rs`(16.9 KB)、`command_safety/windows_dangerous_commands.rs`(25 KB)、`shell_detect`、`shell_snapshot_capture` 等。Unix/PowerShell 两条路径齐备。
- **建议：只当参考，或只抽 `command_safety` 单模块。**
  `command_safety/is_dangerous_command.rs`(11.5 KB) + `windows_dangerous_commands.rs`(25 KB) 是现成的「危险命令黑名单 + tree-sitter 解析」。如果只想要「bash 工具前置风险判定」，可以把 `command_safety/` 整目录抠出来，但必须连带替换掉 `powershell_parser.rs:128` 里的 `codex_protocol::shell_environment::scrub_non_inheritable_env_vars`（一行）。

### 2.4 `execpolicy` / `execpolicy-rules` → 命令白名单

#### `execpolicy-rules` —— 本仓库最佳搬运候选

- **crate 名**：`codex-execpolicy-rules`（lib only，`test = false`）
- **对外暴露**（`src/lib.rs:11-30`）：`Decision`、`Policy`、`Evaluation`、`MatchOptions`、`RequirementsExecPolicy`、`Rule`、`RuleMatch`、`RuleRef`、`PrefixRule`、`PrefixPattern`、`PatternToken`、`NetworkRuleProtocol`、`executable_lookup_key`、`executable_path_lookup_key`、`Error`/`ErrorLocation`/`TextPosition`/`TextRange`、`rule`。
- **有没有 codex-core / 模型 crate**：**完全没有**。`Cargo.toml:17-24` 只有 7 个：`caseless`、`codex-utils-absolute-path`、`multimap`、`serde`、`shlex`、`thiserror`、`unicode-normalization`。唯一 codex 依赖 `utils/absolute-path` 本身也很轻（`utils/absolute-path/Cargo.toml:11-19`：`dirs`、`dunce`、`schemars`、`serde`、`ts-rs`）。
- **Windows**：纯逻辑，无平台 cfg。注意 `executable_lookup_key` 内部处理 Windows 大小写/`.exe` 后缀（用 `caseless` crate，说明有考虑）。
- **建议：直接搬。** 这是整仓唯一「依赖干净 + Windows 可用 + 逻辑有真实价值（前缀规则匹配、可执行名归一化）」的组件。

#### `execpolicy` —— 加一层 Starlark

- **crate 名**：`codex-execpolicy`，lib + bin `codex-execpolicy`（`Cargo.toml:8-15`）
- **对外暴露**（`src/lib.rs:7-31`）：`PolicyParser`（Starlark 规则文件解析）、`ExecPolicyCheckCommand`（`src/execpolicycheck.rs:17`，clap 参数 `--rules <PATH>...`，输出 JSON）、`blocking_append_allow_prefix_rule`、`blocking_append_network_rule`、`prefix_rule_migration`，其余全部重导出 `execpolicy-rules`。
- **有没有 codex-core / 模型 crate**：无。`Cargo.toml:20-32` 在 rules 基础上加 `starlark` 0.14.2、`clap`、`tokio(fs,io-util)`、`tempfile`、`multimap`、`shlex`。
- **重量级第三方**：`starlark` 0.14（`Cargo.toml:535`，`default-features = false`）——纯 Rust，能编，但体积显著（Starlark 解释器 + 语法树）。
- **Windows**：纯逻辑无 cfg。src 8 个文件。
- **建议：直接搬，但按需选。** 如果只需要「命令前缀白名单/黑名单」，用 `execpolicy-rules` 就够，**不要**引入 Starlark。只有在想给用户开放可编辑的 `.starlark` 策略文件时才搬 `execpolicy`。

### 2.5 `sandboxing` / `linux-sandbox` / `windows-sandbox-rs` / `mxc-sandbox`

#### `sandboxing`

- **crate 名**：`codex-sandboxing`（lib only）
- **对外暴露**（`src/lib.rs:18-68`）：`SandboxManager`、`SandboxCommand`、`SandboxExecRequest`、`SandboxExecutables`、`SandboxNetwork`、`SandboxSelection`、`SandboxType`、`SandboxablePreference`、`SandboxTransformRequest`/`Error`、`spawn_process` + `SpawnRequest`/`SpawnOptions`/`WindowsSandboxSpawnRequest`、`WrappedSandboxCommand`、`get_platform_sandbox`、以及一堆 `record_*_sandbox_violation`、`windows_*` 判定函数。
- **有没有 codex-core / 模型 crate**：无 core，但 `Cargo.toml:15-35` 是**全家桶**：`codex-mxc-sandbox`、`codex-network-proxy`、`codex-protocol`、`codex-uds`、`codex-utils-pty`、`codex-windows-sandbox`，Windows 上还加 `codex-otel` + `codex-utils-home-dir`。
- **重量级第三方**：`portable-pty`(vendored wezterm)、`which`、`dunce`、`libc`、`regex-lite`、`tokio`。
- **Windows**：有 `windows.rs`(20.4 KB) / `windows_mxc.rs` / `windows_tests.rs`，能编，但功能依赖外部 setup 二进制。
- **建议：放弃。** src 34 个文件（`seatbelt.rs` 40 KB + `seatbelt_tests.rs` 117 KB + `manager.rs` 31.6 KB + `manager_tests.rs` 40 KB + `policy_transforms_tests.rs` 49 KB）。`src/lib.rs:28` 直接 `pub use codex_protocol::permissions::...`，被 protocol 绑死。只值得参考 `manager.rs` 的 `SandboxTransformRequest → WrappedSandboxCommand` 这层抽象。

#### `linux-sandbox`

- **crate 名**：`codex-linux-sandbox`，lib + bin 同名（`Cargo.toml:7-14`）。
- **有没有 codex-core**：无（但 dev-dependencies 里有 `codex-core`，`:46`）。
- **平台门控**：`Cargo.toml:19-43` **全部依赖都在 `[target.'cfg(target_os = "linux")'.dependencies]` 下**；`src/lib.rs:53-56` 在非 Linux 上是 `panic!("codex-linux-sandbox is only supported on Linux")`。
- **重量级第三方**（Linux only）：`landlock`、`seccompiler`、`smoltcp`、`etherparse`、`hickory-proto`、`socks5-protocol`、`rustix`、`codex-network-proxy`。
- **Windows**：编译能过（空壳），功能为零。
- **建议：放弃。**

#### `windows-sandbox-rs`

- **crate 名**：`codex-windows-sandbox`，lib + **3 个 bin**（`Cargo.toml:13-23`）：`codex-windows-sandbox-setup`、`codex-command-runner`、`codex-windows-managed-deny-probe`。另有独立 crate `windows-sandbox-service`（`Cargo.toml:130`）。
- **有没有 codex-core**：无，但 `Cargo.toml:29-58` 依赖 `codex-protocol`、`codex-otel`、`codex-http-client`、`codex-utils-pty`、`codex-utils-process`。
- **重量级第三方**：`windows` 0.58 + **31 个 windows-sys feature**（`Cargo.toml:68-102`，含 WFP 防火墙、AppContainer、Job Objects、RPC、LSA）。
- **Windows**：主战场。`src/lib.rs:60-70` 大量 `#[cfg(target_os = "windows")]` 模块。
- **建议：放弃。** `windows-sandbox-rs/src` 有 **118 个 .rs 文件**（`acl.rs` 40 KB、`setup.rs` 99 KB、`setup_provisioning/` 58 KB、`wfp.rs`、`conpty/`、`elevated/`…）。它需要管理员预置、独立服务进程、两个 helper exe。给 8 工具 MCP server 用完全不划算。

#### `mxc-sandbox`

- **crate 名**：`codex-mxc-sandbox`（lib only）
- **有没有 codex-core**：无，但 `Cargo.toml:18-27` = `codex-network-proxy` + `codex-protocol` + `codex-windows-sandbox` + **`mxc-sdk`（git 依赖**，`Cargo.toml:452` `github.com/microsoft/mxc` rev `c6620183`）。
- **Windows**：实质 Windows-only。`src/lib.rs:4-12`：`availability`/`native`/`windows` 模块全在 `#[cfg(windows)]` 下，非 Windows 只剩 `policy`(portable) + `transport`。`Cargo.toml:29-31` 还钉死了 `tracelogging = "=1.2.3"`（注释说明 1.2.4 的 OneCore_apiset 在 GNU 工具链缺失）。
- **建议：放弃。** 引入一个第三方 git SDK + 一个 Windows 沙箱 crate，只为了做进程隔离。

### 2.6 `exec-server` / `exec-server-protocol` / `exec-server-cli`

#### `exec-server`（lib）

- **crate 名**：`codex-exec-server`
- **对外暴露**（`src/lib.rs:70-263`，约 190 条 `pub use`）：
  - 文件系统抽象：`codex_file_system::*` 全量重导出——`ExecutorFileSystem`、`FileSystemSandboxContext`、`ReadFileOptions`、`WriteFileOptions`、`RemoveOptions`、`CreateDirectoryOptions`、`GetMetadataOptions`、`WalkOptions`/`WalkEntry`/`WalkOutcome`、`FILE_READ_CHUNK_SIZE`/`FILE_WRITE_CHUNK_SIZE`、`LocalFileSystem`、`LOCAL_FS`(`:142-143`)。
  - 进程：`ExecBackend`/`ExecBackendFuture`、`ExecProcess`、`ExecProcessEvent`、`ExecProcessEventReceiver`、`StartedExecProcess`、`ProcessSignal`、`ProcessOutputChunk`。
  - RPC 协议：`codex_exec_server_protocol::*` 全量（`Fs*Params`/`Fs*Response`/`Exec*`/`Read*`/`Write*`/`Signal*`/`Terminate*`/`Initialize*` 等）。
  - 服务：`run_main(listen_url, runtime_paths, http_client_factory)`（`src/server.rs:30`）、`run_main_with_telemetry`、`DEFAULT_LISTEN_URL`、`RequestDispatchMode`、`ConcurrentRequestLimit`。
  - 远程环境：`run_remote_environment*`、`EnvironmentManager`、`RemoteEnvironmentConfig`、noise 通道（`NoiseChannelIdentity`/`NoiseChannelPublicKey`）。
  - Windows 沙箱完整性检查：`run_integrity_checks`（`:259-263`）。
- **有没有 codex-core / 模型 crate**：**没有**。但 `Cargo.toml:28-75` 拖进 `codex-api`、`codex-config`、`codex-otel`、`codex-http-client`、`codex-network-proxy`、`codex-protocol`、`codex-sandboxing`、`codex-shell-command`、`codex-skills`、`axum`、`prost`、`tokio-tungstenite`、`notify`、`opentelemetry`。
- **协议形态**：**不是 MCP**。`src/server/transport.rs:55` `DEFAULT_LISTEN_URL = "ws://127.0.0.1:0"`，是自定义 JSON-RPC over WebSocket（也有 stdio 路径，见 `server/transport_tests.rs:19` 的 `run_stdio_connection_with_io`）。
- **Windows**：可以。`src/lib.rs:45-46` 的 `sandbox_integrity` 明确覆盖 `linux|macos|windows`；只有 `shell_snapshot*` 三个模块是 `#[cfg(unix)]`（`:51-56`）。
- **建议：只当参考。** `src/` 下 **166 个 .rs 文件**。值得抄的两个点：(a) `ExecutorFileSystem` trait 的形状（这就是我们 read/write/edit 该有的抽象）；(b) `ExecProcessEvent` / `ExecProcessEventReceiver` / `ProcessOutputChunk` 的增量输出模型（就是我们要的 `job_start` + `job_output`）。

#### `exec-server-protocol`（lib）

- **crate 名**：`codex-exec-server-protocol`
- **对外暴露**（`src/lib.rs:8-13`）：`capabilities`、`environment_config`、`network_policy`、`process_id::ProcessId`、`protocol`、`rpc` 全量重导出。
- **有没有 codex-core**：无。`Cargo.toml:16-28` = `base64`、`codex-file-system`、`codex-install-context`、`codex-network-proxy`、`codex-protocol`、`codex-shell-command`、`codex-skills`、`serde`、`serde_json`，Windows 加 `codex-mxc-sandbox`。
- **Windows**：可以。
- **建议：只当参考。** 想复用它的协议定义就必然背上 `codex-skills` + `codex-network-proxy`。

#### `exec-server-cli`（bin）

- **crate 名**：`codex-exec-server-cli`，bin 名 `codex-exec-server`（`Cargo.toml:7-9`），`src/main.rs` 只有 15 行。
- **有没有 codex-core / 模型 crate**：**有** `codex-core`(`:27`)、`codex-model-provider`(`:31`)、`codex-login`(`:30`)、`codex-app-server`(`:22`)、`codex-aws-auth`(`:23`) → **agent 层**。
- **建议：放弃（自己 build）。** 但注意：`cli/src/main.rs:244-245` 也有 `Subcommand::ExecServer`，所以 `codex exec-server` 子命令存在；且 Release 直接提供 `codex-exec-server-<triple>` 预编译二进制（见 §3）。

### 2.7 `message-board-mcp` → 现成 MCP server 范式

- **crate 名**：`codex-message-board-mcp`，lib + bin 同名（`Cargo.toml:7-16`）。
- **对外暴露**（`src/lib.rs:8-10`）：`serve_http(...)`、`LocalServer`、`launch_in_memory`、`MessageBoardMcpServer`。
- **`serve_http` 完整签名**（`src/http.rs:43-52`）：

  ```rust
  pub async fn serve_http<F, Fut>(
      listener: TcpListener, token: String,
      config: StreamableHttpServerConfig, bind: F,
  ) -> anyhow::Result<()>
  ```

- **这份代码正好覆盖我们要的能力**：
  - Bearer 校验：`src/http.rs:53-55` 把 token 造成 `HeaderValue::from_str(&format!("Bearer {token}"))` 并 `set_sensitive(true)`；`:80-88` 用 `axum::middleware::from_fn` 在 `AUTHORIZATION` 头精确比对，不等则 401。
  - streamable HTTP 挂载：`:63-79` `Router::new().nest_service("/mcp", StreamableHttpService::new(handler_factory, LocalSessionManager::default(), config))`。
  - Host 校验：`src/main.rs:26-27` + `:54` `http.allowed_hosts.extend(args.allowed_hosts)`（rmcp 自带 `allowed_hosts`，默认放行 loopback）。
  - 优雅关闭 + session 排空：`src/http.rs:89-104`，注释明确说明「rmcp 的 HTTP token 不会停 legacy session worker，必须显式 close」——**这是个真坑，抄这段就不用自己踩**。
  - 启动即打印真实端口：`src/main.rs:46-50` 输出 `{"url":"http://{addr}/mcp"}`（因为我们大概率也监听 `:0`）。
- **有没有 codex-core / 模型 crate**：无 core，但 `Cargo.toml:26-40` = `codex-attachment-store`、`codex-message-board`、`codex-protocol`、`codex-state`(→ **sqlx**，`state/Cargo.toml:21-23`，`sqlite-bundled`)、`codex-tools`(→ `codex-code-mode`，`tools/Cargo.toml:13`)、`rmcp`(git)、`axum`、`futures`、`sqlx`、`uuid`。
- **重量级第三方**：`sqlx` + `libsqlite3-sys`（bundled SQLite）、`axum` 0.8、`rmcp`（**git 依赖**，`Cargo.toml:487` rev `b11a40d8`，`=3.6.0` + `server` + `transport-streamable-http-server` feature）。
- **Windows**：无平台 cfg。但 `codex-state` → `sqlx-sqlite` 在 `Cargo.toml:697-698` 被 patch 到 `transact-rs/sqlx` fork。
- **建议：只当参考（照抄 `http.rs`，不搬 crate）。**
  `src/http.rs` 共 170 行、6.5 KB，其中真正的「MCP boilerplate」约 100 行。**在我们自己项目里用官方 `rmcp` crate + axum，把 `serve_http` 这个函数照着写一遍**，成本比剥离 `codex-message-board` / `codex-state` 低一个数量级。
  另：`lib.rs:153-186` 的 `list_tools_result` 展示了如何把内部 `ToolSpec` 转成 rmcp `Tool`（含 schema 校验与分页拒绝），也值得参考。

### 2.8 `tcp-tunnel` / `network-proxy`

#### `tcp-tunnel`

- **crate 名**：`codex-tcp-tunnel`（lib only）
- **对外暴露**（`src/lib.rs:35-36`）：`run_ssh_proxy`、`run_ssh_proxy_from_file`；`Args`（`:42-59`，`--proxy-url` 默认 `ssh::PUBLIC_GATEWAY`、`--environment-id`、`--port`、`--token-file`）。
- **有没有 codex-core**：**零 codex 依赖**。`Cargo.toml:10-26` 全是第三方。
- **重量级第三方**：`h3` + `h3-quinn`（**git 依赖** `hyperium/h3` rev `e07e694`）、`quinn` 0.11、`h2`、`hyper-rustls`、`rustls`、`tokio-rustls`、`rustls-native-certs`。
- **Windows**：无平台 cfg，`rustls` ring 后端跨平台。
- **建议：放弃。** 用途是「SSH 拥有的、到 Cloud Portals 网关的 HTTP/2 CONNECT 隧道」（`src/lib.rs:1`），与我们「本地 MCP server + Cloudflare 隧道」的场景无关。src 7 个文件。

#### `network-proxy`

- **crate 名**：`codex-network-proxy`，lib + bin 同名（`Cargo.toml:7-14`）
- **对外暴露**（`src/lib.rs:42-146`，约 95 条 `pub use`）：`NetworkProxy`/`NetworkProxyBuilder`/`NetworkProxyHandle`、`NetworkProxyState`、`NetworkPolicyDecider`、`NetworkDecision`、`NetworkMode`、`NetworkProxyConfig`、`CredentialBrokerContext`/`CredentialProviderConfig`、`MitmHookConfig`、`TcpUpstreamProxy`、`is_non_public_ip`、`normalize_host`、`PROXY_ACTIVE_ENV_KEY`/`NO_PROXY_ENV_KEYS` 等。
- **有没有 codex-core**：零 codex-core。`Cargo.toml:20-55` 只有 `codex-utils-*`（4 个轻量 utils）。
- **重量级第三方**：`rama-core`/`rama-http`/`rama-http-backend`/`rama-net`/`rama-socks5`/`rama-tcp`/`rama-tls-rustls`（**7 个，全部 `=0.3.0-alpha.4`**）+ `aws-sigv4` + `aws-credential-types` + `opentelemetry` + `schemars` + `scep`… 还有 `globset`、`regex-automata`、`sha2`、`rustls-native-certs`。Windows 上另加 `schannel` + `windows-sys`(6 feature)。
- **Windows**：可以，`src/lib.rs:37-40` 有 `windows_proxy_ingress` / `windows_tcp_attribution` 模块；`Cargo.toml:70-79` 有 windows target deps。
- **建议：放弃。** `src/` **75 个 .rs 文件**，`proxy.rs` 125 KB、`runtime.rs` 96 KB、`http_proxy.rs` 87 KB、`credential_broker.rs` 77 KB、`credential_broker/configured_tests.rs` 128 KB。MITM CA + 凭证代理 + SOCKS5。只有在我们想给 `bash` 加网络出口管控时才值得回头看。

### 2.9 顺手发现的两个「白捡」crate（不在原始清单里，但直接对应我们的工具）

| crate | 依赖 | 用途 |
|---|---|---|
| `utils/head-tail-buffer` | **零依赖**（`Cargo.toml` 只有 `[dev-dependencies] pretty_assertions`） | `HeadTailBuffer<const MAX_BYTES: usize>`（`src/lib.rs:11`）+ `push_chunk`(:41) + `to_bytes_with_omission_marker`(:102) + `format_output_omission_marker`(:164)。**正好是 `job_output` 需要的「保留头部 + 尾部、中间省略计数」有界缓冲。** 直接搬。 |
| `utils/string` | `regex-lite` + `serde` + `serde_json`（`Cargo.toml:11-13`） | `take_bytes_at_char_boundary`（`src/lib.rs:18`）——按字节预算在 UTF-8 字符边界安全截断。**`read`/`job_output` 截断都要用。** 直接搬。 |

另外 `ansi-escape` 名字很像我们需要的（剥 ANSI），但它依赖 `ratatui` + `ansi-to-tui`（`Cargo.toml:15-18`），是给 TUI 渲染用的，**不要搬**。

---

## 3. 构建现实

### 3.1 单独 build 一个 crate 的代价

Cargo 的 workspace 解析不支持「只解析某成员的依赖图」——只要在根 `Cargo.toml` 里 build，`Cargo.lock` 会锁定全仓。真正的成本取决于**该 crate 的依赖闭包**：

| 目标 | 依赖闭包里的重物 | 主观评级 |
|---|---|---|
| `cargo build -p codex-execpolicy-rules` | 只有 `caseless`/`multimap`/`shlex`/`thiserror`/`unicode-normalization`/`serde` + `utils-absolute-path`(`dirs`/`dunce`/`schemars`/`ts-rs`)。**几分钟内可完成。** | 很轻 |
| `cargo build -p codex-file-search` | `clap`、`ignore`、`nucleo`(git)、`crossbeam-channel`、`tokio(full)`。`nucleo` 需从 helix fork 拉取。 | 轻 |
| `cargo build -p codex-execpolicy` | 上文 + `starlark` 0.14（Starlark 解释器） | 中 |
| `cargo build -p codex-apply-patch` | **不是「一个小 patch 库」**：→ `codex-exec-server` → `codex-config`(`tonic`+`prost`+`toml_edit`)、`codex-api`(`tokio-tungstenite`+`tungstenite`+`rustls`)、`codex-otel`(5 个 opentelemetry crate)、`codex-network-proxy`(**7 个 `rama-*` alpha**+`aws-sigv4`)、`codex-protocol`(`icu_*`+`gix-url`+`ts-rs`)、`codex-skills`。加上 `tree-sitter` + `tree-sitter-bash` 的 C 编译。 | 重 |
| `cargo build -p codex-exec-server` | 上述全套 + `axum` + `tokio-tungstenite` + `notify` + `opentelemetry`。166 个源文件。 | 极重 |
| `cargo build -p codex-message-board-mcp` | + `sqlx`(`libsqlite3-sys` bundled SQLite，编译很慢) + `rmcp`(git) + `codex-tools`→`codex-code-mode` | 重 |

**结论：想「只 build apply-patch」在这个 workspace 里做不到轻量。** 真正轻的路径是**复制源码到新项目**，让新项目自己解析依赖——那样 `apply-patch` 的 parser 部分只需要 `similar` + `tree-sitter` + `tree-sitter-bash`（如果不保留树状解析，甚至只需要 `similar`）。

### 3.2 全仓的「重物」清单

| 重物 | 位置 | 影响范围 |
|---|---|---|
| **`v8 = "=152.2.0"`**（patch 到 `openai-oss-forks/rusty_v8`，`Cargo.toml:581,701`） | 只被 `code-mode-runtime/Cargo.toml:30`（`features = ["v8_enable_sandbox"]`）和 `v8-poc` 使用 | **与我们 8 个工具完全无关**，避开 `code-mode-*` 就不会碰 |
| **`deno_core_icudata`**（`Cargo.toml:400`） | 同上，`code-mode-runtime/Cargo.toml:23` | 无关 |
| **`portable-pty` = 0.9**（`utils/pty/Cargo.toml:12`，即 vendored wezterm） | `utils/pty`，被 `sandboxing` / `exec-server` / `windows-sandbox-rs` / `cli` 使用 | 只在我们需要 PTY 时才碰 |
| **`openssl-sys = "*"`**（`Cargo.toml:456`，cargo-shear 白名单里） | 平台特定；`http-client/Cargo.toml:35` Windows 分支是 `curl = { features = ["static-curl", ...] }` | 走 protocol 链才碰 |
| **`sqlx` + `libsqlite3-sys`(bundled) + patch 到 transact-rs fork**（`Cargo.toml:521-534,697-698`） | `codex-state` / `message-board-mcp` / `cli` | 走 message-board 才碰 |
| **`tonic`/`prost`/`tonic-prost-build`**（`Cargo.toml:565-566`） | `codex-config`(`config/Cargo.toml:47-48`)、`exec-server` | 走 exec-server 才碰 |
| **`rama-*` 0.3.0-alpha.4 ×7** | `codex-network-proxy` | 走 protocol 就碰（**最高频的隐性陷阱**） |
| **`tree-sitter` + bash + powershell** | `apply-patch`、`shell-command`、`skills` | C 编译，但可接受 |

### 3.3 官方预编译二进制 / npm 包

证据：`.github/scripts/fixtures/codex-0.167.0-alpha.2-assets.txt`（Release 资产清单快照）。

- **有 `codex-exec-server` 预编译**：`:81-98` 覆盖 `aarch64/x86_64` × `apple-darwin` / `pc-windows-msvc` / `unknown-linux-musl`，Windows 是 `.exe` + `.zip`。**可以直接下载当独立执行服务用，完全不 build。**
- 还有 `codex-command-runner`(:72-80)、`codex-windows-sandbox-setup`(:165-173)、`codex-windows-sandbox-service`(:156-164)、`bwrap`(:5-11)、`codex-code-mode-host`(:54-71)、`codex-app-server`(:23-53)、`codex-responses-api-proxy`(:125-144)。
- **没有 `apply_patch` 独立产物，也没有 `codex-file-search` 独立产物**（整份清单里两个名字都不出现）。
- **npm**：`codex-cli/package.json:6-15` → `"bin": { "codex": "bin/codex.js" }`，`files` 只有 `bin/codex.js`；平台二进制走 `codex-npm-win32-x64` 等 tarball（资产清单 `:99-105`）。**npm 只给 `codex` 一个入口。**

**但发现两条「不 build 也能用」的侧门**：

1. **apply_patch 藏在 `codex` 二进制里**。`arg0/src/lib.rs:75-77` 按 argv[0] 分发：可执行文件叫 `apply_patch`（或拼错的 `applypatch`）就直接跑 apply-patch；`:94` 还认隐藏 flag `--codex-run-as-apply-patch`（常量定义在 `apply-patch/src/lib.rs:52`），`:398-405` 在 Windows 上就是生成 `apply_patch.bat` 调它。所以可以 `codex.exe --codex-run-as-apply-patch "<patch>"` 零构建复用。
2. **`rg` 是随包分发的资源**。`.github/scripts/build-codex-package-archive.sh:62-65` 有 `--rg-bin` 参数，release 包会带 ripgrep。这对我们 `grep` 工具有直接参考价值：**codex 自己也不内嵌 grep，而是调外部 rg**（`exec-server/src/lib.rs` 无 grep 模块；`shell-command` 也只有 `bash.rs`/`parse_command.rs`，没有 grep 搜索实现）。

---

## 4. 许可证

### 4.1 事实

- 顶层 `LICENSE`：**Apache License 2.0** 原文（`LICENSE:1-3`）。
- 每个 crate 的 `Cargo.toml` 都写 `license.workspace = true`，指向 `Cargo.toml:187` 的 `license = "Apache-2.0"`。抽查 `apply-patch/Cargo.toml:5`、`file-search/Cargo.toml:5`、`execpolicy-rules/Cargo.toml:5`、`exec-server/Cargo.toml:6` 全部命中。
- **有 `NOTICE` 文件**（根目录，248 B）：

  ```
  OpenAI Codex
  Copyright 2025 OpenAI

  This project includes code derived from [Ratatui](https://github.com/ratatui/ratatui), licensed under the MIT license.
  Copyright (c) 2016-2022 Florian Dehau
  Copyright (c) 2023-2025 The Ratatui Developers
  ```

- 第三方资产另算：`codex-rs/vendor/bubblewrap/LICENSE`（仅 7 字节，内容未确认）、`third_party/wezterm/LICENSE`(1.07 KB, MIT)、`codex-rs/skills/src/assets/samples/*/LICENSE.txt`（4 份 ~11 KB，内容未确认）。`docs/license.md` 仅 87 B（未读取，未确认是否为指针）。

### 4.2 搬进另一个项目要满足什么（Apache-2.0 §4）

1. **带一份 LICENSE**：项目中保留 `LICENSE`（Apache-2.0 全文）副本。
2. **保留 NOTICE**：Apache-2.0 §4(d) 要求随分发保留 NOTICE 文件内容。至少要保留 `Copyright 2025 OpenAI` 这一行。Ratatui 那条只在搬 `ansi-escape` / `tui` 等 ratatui 衍生代码时才需要——不搬 TUI 就不必。
3. **标注修改**：§4(b) 要求「对修改过的文件显著声明已修改」。→ 若改写 `apply-patch/src/file_update.rs` 换掉 FS 后端，需在该文件头加注释说明「derived from openai/codex, modified」。
4. **保留归属声明**：源文件里的版权/专利/商标/归属注释不得删除。
5. **无 copyleft 传染**：Apache-2.0 是宽松许可，可以闭源分发，只需满足上述归属义务。唯一要注意的是 `bwrap` 二进制（上游 bubblewrap 为 LGPL-2.1+）——不打包它就没关系。
6. **传递依赖**：搬 `file-search` 会带入 `nucleo`(git fork)、`ignore`、`serde`；搬 `execpolicy` 会带入 `starlark`。这些各自的 license 本次未逐个核对（未确认），落地前应 `cargo license` 扫一遍。

---

## 5. 8 个工具的对照表

| # | 工具 | 决策 | 复用来源 | 一句话理由 |
|---|---|---|---|---|
| 1 | `read` | **自己写** | 可借 `utils/string::take_bytes_at_char_boundary`（`utils/string/src/lib.rs:18`） | codex 的读文件逻辑埋在 `exec-server/src/local_file_system.rs`(48 KB) + `local_file_system_read.rs`，为了「按行号切片 + UTF-8 边界截断」把它整条 protocol/rama 链拖进来不值当。 |
| 2 | `write` | **自己写** | — | 原子写（temp + rename）+ 保留 CRLF 是几十行代码；`exec-server` 的 `WriteFileOptions`/`FsWriteBlockParams` 抽象是为「分块 + 沙箱 + 远程 FS」设计的，我们用不上。 |
| 3 | `edit` | **搬 `apply-patch` 的算法，换掉 FS 层** | `apply-patch/src/{parser,streaming_parser,seek_sequence,text_file,file_update,invocation}.rs` | 唯一有真护城河的是「模糊上下文匹配 + 多 hunk 定位」（`seek_sequence.rs` + `parser.rs` 56 KB），自己重写必出错；但 `file_update.rs:1-4` 的 `ExecutorFileSystem` 必须换成自有 FS trait，否则会拉进 `codex-exec-server`。 |
| 4 | `bash` | **自己写**，参考 `shell-command` 的 `command_safety/` + `execpolicy-rules` 做风险判定 | `shell-command/src/command_safety/`（40 KB）、`execpolicy-rules`（整 crate，7 个轻依赖） | codex **没有**独立 bash 执行器——`shell-command` 只是 parser（无 spawn/PTY）。执行本体（子进程、进程组、超时、输出流）用 `tokio::process` 自己写更短；白名单/黑名单用 `execpolicy-rules`（本仓唯一干净可搬 crate）。 |
| 5 | `glob` | **自己写**，抄 `file-search` 的 walker 配置 | `file-search/src/lib.rs:458-474`（`ignore::WalkBuilder` 参数）、`globset`（workspace 已有） | `codex-file-search` 是 **fzf 模糊评分**（`nucleo` 打分排序），不是 glob 语义，直接当 glob 用会返回错误结果；但「`.gitignore` 感知的遍历」这段 20 行参数选择（`hidden(false)` + `follow_links(true)` + `require_git(true)`）直接照抄。 |
| 6 | `grep` | **自己写（调 `rg --json`）** | — | codex 自身也没有内嵌 grep 实现，它靠打包 ripgrep 子进程（`build-codex-package-archive.sh:62-65` 的 `--rg-bin`）。搜遍 `core/src`、`tools/src` 都没有 grep 工具模块。直接 `ripgrep --json` 解析最省事。 |
| 7 | `job_start` | **自己写**，参考 `exec-server` 的进程事件模型 | `exec-server/src/lib.rs:148-154`（`ExecProcess` / `ExecProcessEvent` / `ExecProcessEventReceiver` / `StartedExecProcess` / `ProcessSignal`） | 事件枚举（Started / OutputDelta / Exited）的设计正好对应我们的 `job_start` 返回 job_id + 后台采集，但 `exec-server` 本身 166 个源文件、依赖 `codex-config`(tonic)+`codex-api`+`codex-otel`，只抄形状不抄代码。 |
| 8 | `job_output` | **搬 `utils/head-tail-buffer`（零依赖）** | `utils/head-tail-buffer/src/lib.rs`（`HeadTailBuffer<MAX_BYTES>`、`push_chunk`、`to_bytes_with_omission_marker`、`format_output_omission_marker`） | job 输出必须是有界缓冲 + 「中间省略 N 字节」标记；这个 crate **没有任何依赖**，`Cargo.toml` 里连 `[dependencies]` 段都没有，纯 std，直接拷文件即可。 |

**MCP 传输层（不在 8 个工具里，但必须做）**：照抄 `message-board-mcp/src/http.rs:43-105` 的 100 行范式（Bearer middleware + `nest_service("/mcp", StreamableHttpService)` + `allowed_hosts` + 优雅关闭 + session 排空），但用官方 `rmcp` crate 自己组装，**不要**依赖 `codex-message-board-mcp`（它会带入 `sqlx` + `codex-tools` + `codex-state`）。

**复用总量估算**：直接可搬的只有 2 个小 crate（`head-tail-buffer`、`utils/string`）+ 1 个中 crate（`execpolicy-rules`）；需要改造的有 1 个（`apply-patch` 的算法层）；其余全是「读代码抄思路」。

---

## 6. 引用清单

### workspace 与分界
- `Cargo.toml:2-177` — members（174 条，含 4 个 `*tests/support`）
- `Cargo.toml:180-187` — `version` / `edition = "2024"` / `license = "Apache-2.0"`
- `Cargo.toml:189-356` — 内部 crate 路径映射
- `Cargo.toml:358-607` — 外部依赖版本表
- `Cargo.toml:691-707` — `[patch.crates-io]`：crossterm / sqlx-core / sqlx-sqlite / tokio-tungstenite / tungstenite / v8 全部指向 git fork
- `core/src/client.rs:356` — `pub struct ModelClient`（全仓唯一，agent 层锚点）
- `protocol/Cargo.toml:15-54` — protocol 的重依赖（`codex-network-proxy`:22、`codex-http-client`:21、`gix-url`:31、`icu_*`:34-36、`ts-rs`:48）
- `http-client/Cargo.toml:14,16,35` — `native-tls` / `reqwest` / Windows `curl(static-curl)`
- `network-proxy/Cargo.toml:47-53` — 7 个 `rama-* = "=0.3.0-alpha.4"`

### apply-patch
- `apply-patch/Cargo.toml:7-14` — lib `codex_apply_patch` + bin `apply_patch`
- `apply-patch/Cargo.toml:19-28` — 依赖，其中 `:21` = `codex-exec-server`
- `apply-patch/src/lib.rs:24-41` — pub API；`:52` = `CODEX_CORE_APPLY_PATCH_ARG1`
- `apply-patch/src/parser.rs:26-31` — 只依赖 `streaming_parser` + `PathUri`（无 exec-server）
- `apply-patch/src/file_update.rs:1-4` — 依赖 `ExecutorFileSystem` / `FileSystemSandboxContext` / `ReadFileOptions`
- `apply-patch/src/invocation.rs:150-153,168-171,180-184` — 签名里带 `&dyn ExecutorFileSystem`
- `arg0/src/lib.rs:75-77` — argv[0] == `apply_patch` 分发；`:94` `--codex-run-as-apply-patch`；`:398-405` Windows `apply_patch.bat`

### file-search
- `file-search/Cargo.toml:19-27` — 7 个依赖，无 codex crate
- `file-search/src/lib.rs:56-70,102-131,147-153,176-229,231-235,309-325,338-351` — pub API
- `file-search/src/lib.rs:257-274` — `cfg(unix)` / `cfg(windows)` 分支
- `file-search/src/lib.rs:458-474` — `WalkBuilder` 配置（walker 参数来源）
- `Cargo.toml:454` — `nucleo` git 依赖

### shell-command
- `shell-command/Cargo.toml:10-24` — 依赖，`:12` = `codex-protocol`，`:20-22` = 3 个 tree-sitter
- `shell-command/src/lib.rs:1-14` — pub API（无进程派生）
- `shell-command/src/shell_snapshot_render.rs:5-6` / `parse_command.rs:5` / `command_safety/powershell_parser.rs:128` — 使用 protocol 的具体位置

### execpolicy / execpolicy-rules
- `execpolicy-rules/Cargo.toml:17-24` — 7 个轻依赖
- `execpolicy-rules/src/lib.rs:11-30` — pub API
- `execpolicy/Cargo.toml:8-32` — lib + bin，`:29` = `starlark`
- `execpolicy/src/lib.rs:7-31` — pub API
- `execpolicy/src/execpolicycheck.rs:17-23` — `ExecPolicyCheckCommand { rules: Vec<PathBuf> }`

### sandboxing / linux-sandbox / windows-sandbox-rs / mxc-sandbox
- `sandboxing/Cargo.toml:15-35` — 依赖（protocol/network-proxy/mxc/windows-sandbox/uds/pty，Windows 额外 otel）
- `sandboxing/src/lib.rs:1-15,25-29,33-68` — 模块 cfg 与 pub API
- `linux-sandbox/Cargo.toml:19-43` — 全部 linux-target 依赖；`:46` dev-dep `codex-core`
- `linux-sandbox/src/lib.rs:48-56` — 非 Linux 的 `panic!` 桩
- `windows-sandbox-rs/Cargo.toml:13-23` — 3 个 bin；`:28-58` 依赖；`:68-102` 31 个 windows-sys feature
- `windows-sandbox-rs/src/lib.rs:5-13,60-70` — cfg 门控
- `mxc-sandbox/Cargo.toml:17-39` — 依赖 + `mxc-sdk`；`:29-31` Windows `tracelogging = "=1.2.3"`
- `mxc-sandbox/src/lib.rs:1-12` — Windows-only 模块

### exec-server 三件套
- `exec-server/Cargo.toml:21-95` — 依赖（含 `codex-api`/`codex-config`/`codex-otel`/`codex-network-proxy`/`codex-sandboxing`/`codex-skills`）
- `exec-server/src/lib.rs:70-257` — pub API；`:142-143` `LOCAL_FS`/`LocalFileSystem`；`:148-154` `ExecProcess*`；`:45-56` 平台 cfg
- `exec-server/src/server/transport.rs:55` — `DEFAULT_LISTEN_URL = "ws://127.0.0.1:0"`
- `exec-server/src/server.rs:20-21,30-45,51-66` — `run_main` / `run_main_with_telemetry`
- `exec-server-protocol/Cargo.toml:15-28` / `src/lib.rs:8-13` — 协议 crate 的依赖与导出
- `exec-server-cli/Cargo.toml:7-9,27,30-31` — bin 名 + `codex-core`/`codex-login`/`codex-model-provider`
- `cli/src/main.rs:244-245,1954-1962` — `codex exec-server` 子命令存在

### message-board-mcp
- `message-board-mcp/Cargo.toml:7-40` — lib + bin；依赖含 `codex-state`(:29)/`codex-tools`(:30)/`rmcp`(:34)/`sqlx`(:37)
- `message-board-mcp/src/http.rs:43-52` — `serve_http` 签名
- `message-board-mcp/src/http.rs:53-55` — Bearer HeaderValue + `set_sensitive`
- `message-board-mcp/src/http.rs:63-88` — `nest_service("/mcp", StreamableHttpService)` + Bearer middleware
- `message-board-mcp/src/http.rs:89-104` — 优雅关闭 + session 排空
- `message-board-mcp/src/main.rs:26-31,39-50,54` — `allowed_hosts` / `bearer_token_env` / 启动打印 URL
- `message-board-mcp/src/lib.rs:8-10,153-186` — pub exports / `server_info` / `list_tools_result`
- `state/Cargo.toml:21-23` — `sqlx` + `sqlx-macros` + `sqlx-sqlite`
- `tools/Cargo.toml:13` — `codex-code-mode`
- `Cargo.toml:487` — `rmcp` git 依赖（rev `b11a40d8`，`=3.6.0`）

### tcp-tunnel / network-proxy
- `tcp-tunnel/Cargo.toml:10-26` — 零 codex 依赖；`h3`/`h3-quinn` 是 git 依赖
- `tcp-tunnel/src/lib.rs:1,35-36,42-59` — SSH→Cloud Portals 网关隧道，`Args`
- `network-proxy/Cargo.toml:19-79` — `rama-*` ×7 + aws + otel + windows target
- `network-proxy/src/lib.rs:1-41,42-146` — 模块与 pub API

### 白捡的小 crate
- `utils/head-tail-buffer/Cargo.toml:1-15` — **无 `[dependencies]` 段**
- `utils/head-tail-buffer/src/lib.rs:11,22-33,41,93,102,124,164` — `HeadTailBuffer` API
- `utils/string/Cargo.toml:10-13` — `regex-lite` + `serde` + `serde_json`
- `utils/string/src/lib.rs:18` — `take_bytes_at_char_boundary`
- `utils/absolute-path/Cargo.toml:11-19` — `dirs`/`dunce`/`schemars`/`serde`/`ts-rs`
- `utils/path-uri/Cargo.toml:10-18` — 加 `base64`/`url`/`urlencoding`/`ts-rs`
- `ansi-escape/Cargo.toml:15-18` — 依赖 `ratatui` + `ansi-to-tui`（**不要搬**）
- `code-mode-runtime/Cargo.toml:23,30` — `deno_core_icudata` + `v8`（与我们无关）

### 构建 / 发布
- `Cargo.toml:400,456,521-534,565-566,581,697-701` — 重物：`deno_core_icudata`/`openssl-sys`/`sqlx`/`tonic`/`v8`/sqlx fork patch
- `.github/scripts/fixtures/codex-0.167.0-alpha.2-assets.txt:5-11`(bwrap) `:23-53`(app-server) `:54-71`(code-mode-host) `:72-80`(command-runner) `:81-98`(**codex-exec-server**) `:99-105`(npm 平台包) `:125-144`(responses-api-proxy) `:156-173`(windows sandbox)
- `.github/scripts/build-codex-package-archive.sh:62-65` — `--rg-bin`（ripgrep 随包分发）；`:139` exec-server 内嵌进 codex-package；`:159-166` Windows helper 二进制
- `.github/actions/build-cargo-package-binaries/action.yml:108-115` — `cargo build --bin bwrap` + sha256 校验
- `codex-cli/package.json:6-15` — npm 只发 `bin/codex.js`
- `package.json:1-39` — 根 package.json 是 `private` monorepo 维护脚本，非发布包

### 许可证
- `LICENSE:1-3` — Apache License 2.0 原文
- `Cargo.toml:187` — `license = "Apache-2.0"`（全 workspace 继承）
- `NOTICE:1-6` — OpenAI 版权声明 + Ratatui MIT 归属
- `codex-rs/vendor/bubblewrap/LICENSE`（7 B，内容未确认）
- `third_party/wezterm/LICENSE`（1.07 KB）
- `codex-rs/skills/src/assets/samples/{imagegen,openai-docs,skill-creator,skill-installer}/LICENSE*.txt`（各 ~11 KB，内容未确认）
- `docs/license.md`（87 B，未读取，未确认）

---

### 未确认项汇总

1. `codex-rs/vendor/bubblewrap/LICENSE` 的实际内容（7 字节）。
2. `docs/license.md` 的内容（87 B）。
3. `codex-rs/skills/src/assets/samples/*/LICENSE*.txt` 具体许可类型。
4. 第三方依赖（`nucleo`、`rama-*`、`rmcp`、`starlark`、`tree-sitter-*`、`sqlx`）的逐项 license —— 本次未扫。
5. `apply-patch` 用自有 FS trait 替换后能否 100% 保留原有行为（尤其 symlink 不跟随路径 `no_follow` 相关逻辑）—— 需实测，本次只做了静态依赖分析。
6. `codex-exec-server` 预编译二进制在 Windows 上的实际启动参数与鉴权模式 —— 只核到 `codex-exec-server-cli/src/main.rs` 的入口与 `run_standalone()`，未跑通。
