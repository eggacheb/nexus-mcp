# 08: 命令白名单与危险命令拦截

**What to build:** 给执行层加一道闸。配置文件里能列出允许和禁止的命令前缀，明显危险的命令（递归删除、格式化、删盘）在执行前就被拦下并说明原因，而不是靠模型自觉。

**Blocked by:** 03

**Status:** ready-for-agent

- [ ] 配置文件支持命令前缀白名单与黑名单
- [ ] 命中黑名单的命令不执行，返回拒绝理由（说明命中哪条规则）
- [ ] 可执行名做归一化：Windows 上去掉 `.exe`、大小写不敏感
- [ ] 白名单非空且命令未命中时，按配置的策略处理（拒绝或放行），策略默认为拒绝
- [ ] 已知危险模式（递归强制删除、磁盘格式化、注册表批量删除）内置拦截，不依赖用户配置
- [ ] 拦截信息写给模型看：说明被拦的命令、原因、以及可以怎么做替代
- [ ] 白名单规则有单元测试覆盖：前缀匹配、参数位置、大小写、路径形式
- [ ] 拦截不绕过沙箱：即使命令被放行，工作目录仍在根目录内

**复用来源：** 这是整个仓库里唯一「依赖干净、可以直接搬」的组件：codex 的 `execpolicy-rules` crate，只有 7 个轻量依赖（`caseless`、`multimap`、`shlex`、`thiserror`、`unicode-normalization`、`serde`、`utils-absolute-path`），纯逻辑、无平台绑定，Windows 大小写和 `.exe` 后缀都处理过了。直接把源码拷过来。**不要**连带搬 `execpolicy`（它多一层 Starlark 解释器，只在要开放用户可编辑策略文件时才需要）。见 `docs/research/codex-reusable-parts.md` §2.4。危险命令黑名单可以参考 codex `shell-command` 的 `command_safety/` 目录，但只抄规则表，不要抄那个 crate（它依赖 protocol）。
