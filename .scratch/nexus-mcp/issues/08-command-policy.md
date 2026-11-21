# 08: 命令白名单与危险命令拦截

**What to build:** 给执行层加一道闸。配置文件里能列出允许和禁止的命令前缀，明显危险的命令（递归删除、格式化、删盘）在执行前就被拦下并说明原因，而不是靠模型自觉。

**Blocked by:** 03

**Status:** done（2026-11-21，npm run check 全绿，双面审查已过：规范面无硬违规，票面 8 条验收全部落地；审查提出的判断题处理见下方「审查结论」）

**审查结论**：已采纳并修正——闸门调用收拢为 `command_policy::gate()`（消 main.rs/jobs.rs 重复）、`MAX_DENY_PATTERNS_SHOWN` 改名 `MAX_ALLOW_PATTERNS_SHOWN`、删 flush_segment 冗余二次 strip、删零效果的 vitest.config.mjs、deny 集成用例补「替代方案」断言。未采纳（判断题，留作后续）：内置规则三元组合 DangerRule 结构、shell_kind 换枚举（涉及 ShellSpec 协议字段）、规则侧归一化（现状：模式按归一化后的命令文本书写，文档已写明）。

- [x] 配置文件支持命令前缀白名单与黑名单
- [x] 命中黑名单的命令不执行，返回拒绝理由（说明命中哪条规则）
- [x] 可执行名做归一化：Windows 上去掉 `.exe`、大小写不敏感
- [x] 白名单非空且命令未命中时，按配置的策略处理（拒绝或放行），策略默认为拒绝
- [x] 已知危险模式（递归强制删除、磁盘格式化、注册表批量删除）内置拦截，不依赖用户配置
- [x] 拦截信息写给模型看：说明被拦的命令、原因、以及可以怎么做替代
- [x] 白名单规则有单元测试覆盖：前缀匹配、参数位置、大小写、路径形式
- [x] 拦截不绕过沙箱：即使命令被放行，工作目录仍在根目录内

**验收对照**（每条对应的证据）：

1. 白/黑名单 → `crates/executor/src/command_policy.rs` 的 `evaluate` + `tests/command-policy.test.ts` 黑名单/白名单两组用例
2. 黑名单拒绝并说明规则 → `deny_message`，测试 `deny_rule_blocks_and_reports_pattern`、集成「命中黑名单的命令被拒并说明命中的规则」
3. 归一化 → `executable_lookup_key`，测试 `executable_lookup_key_strips_path_drive_and_suffix`、`normalized_exec_hits_allow_pattern`、`RM.EXE -RF x` 集成用例
4. 未命中策略 → `OnUnmatched`，测试 `allow_unmatched_denied_by_default`、`allow_unmatched_allowed_when_configured`、集成「onUnmatched 为 allow 时未命中放行」
5. 内置拦截不依赖配置 → `builtin_danger`，测试 `rm_recursive_force_variants_blocked`、`format_diskpart_reg_delete_blocked`、`powershell_force_delete_blocked_in_pwsh_mode`、`cmd_force_delete_rules_blocked`、集成「不带 policy 字段时内置危险表仍然生效」（`bash_request_builtin_dangerous_without_policy`）
6. 拒绝话术 → `danger_message`/`deny_message`/`unmatched_message`/`fail_closed_message` 均含被拦命令原文、命中规则、替代方案；集成用例断言「替代方案」字样
7. 前缀/参数位置/大小写/路径形式 → `wildcard_prefix_star_matches_bare_and_extended`、`wildcard_star_in_middle_requires_separator`、`deny_pattern_with_position_semantics`、`wildcard_case_insensitive_on_windows`、`wildcard_backslash_normalized_to_slash`、`normalized_exec_hits_allow_pattern`
8. 不绕沙箱 → 集成「白名单放行的命令不绕过沙箱：越界 cwd 仍被拒绝」（cwd 解析链路未动）

**环境备注（跨票事项，做票过程中顺手修的）**：

- 本机 Node 已升到 24.12.0，vitest 5.1.1 的 forks/threads 池在 worker 里把 runner chunk 装载成两份，`describe()` 直接抛「Cannot read properties of undefined (reading 'config')」，整个测试套件跑不起来。绕法：`package.json` 的 test 脚本加 `--pool=vmThreads`（CLI 的 --pool 带默认值会压过 vitest 配置文件里的同名字段，所以写在脚本里）。
- vmThreads 的 VM 上下文里 `fetch` 抛的异常来自主 realm，`toBeInstanceOf(Error)` 跨 realm 判否 → panel 测试「停止后 MCP 端点不可用」改为断言错误消息非空，其余 3 个 panel 失败是该用例失败后的级联（服务停在 stopped）。此改动属于 panel 测试，本票顺手修，复盘时归入「环境升级没被检查拦住」类。
- cargo 的 `timeout_kills_child_and_reports` 在并行负载下偶发时序抖动（AGENTS.md 已有记载），单独重跑即过，与本票无关。

**复用来源：** 原案是搬 codex 的 `execpolicy-rules`（token 级前缀匹配）。开工前调查了 opencode（原调研文档未覆盖，结论已补进 `docs/research/opencode-reusable-parts.md` §4「命令权限/危险命令」），小白拍板改用更轻的组合：

- **匹配引擎**：opencode `packages/core/src/util/wildcard.ts` 的 15 行通配算法（MIT，末尾 ` *` 可省略、`\` 归一 `/`、Windows 大小写不敏感），手写成零依赖 Rust 版，不引入 regex crate。
- **可执行名归一化**：借 codex `shell-command/src/command_safety` 的 `executable_name_lookup_key` 形状（剥路径与盘符、ASCII 折叠、去 `.exe/.cmd/.bat/.com`）。
- **命令拆分**：shlex 分词 + 自写引号感知扫描器（顶层运算符切段、`$()`/反引号递归一层、sudo/env/前导赋值剥离，wrapper 深度 8 超限 fail-closed）。codex 用 tree-sitter 做这件事，C 依赖不在预算内。
- **内置危险表**：codex 的 POSIX rm 谓词与 Windows 删除类规则表照搬；format/diskpart/reg delete 在 codex 与 opencode 里都没有现成规则，自写（口径见下方决策）。opencode 无内置危险清单且文档反对黑名单——内置表定位为兜底 deny，主防线是白名单 + 解析失败即拒绝。

**已拍板的决策**（2026-11-21，小白点头）：

1. 匹配引擎用 opencode 通配，不用 codex `execpolicy-rules`（本票不再搬运该 crate）。
2. rm 拦截条件：递归与强制同时出现（`rm -rf`、`rm -r -f`、`--recursive --force`）；`rm -f build.log` 放行。
3. 内置危险表 = 必选三项（rm 递归强制、format/diskpart、reg delete 一律拦）+ codex 的 Windows 删除类（cmd `del|erase /f`、`rd|rmdir /s /q`、PowerShell 强制删除 cmdlet）；URL 启动类不要。
4. 配置形状：`commandPolicy: { allow: string[], deny: string[], onUnmatched: "deny" | "allow" }`，onUnmatched 默认 deny，非法值启动即报错。
