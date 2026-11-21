# 08: `job_kill` 调研：单个后台任务的终止入口

**What to build:** 模型能主动终止一个还在跑的后台任务（跑挂的构建、测试）。07 号票已把执行器侧地基铺好（Job Object、`TerminateJobObject`、任务注册表、退出时 kill_all），但 8 工具契约下模型没有任何入口能杀单个任务——只能等它自己结束或整个服务退出。本票先调研定方案，调研通过后另开实现票。

**Blocked by:** None（07 已 done）

**Status:** ready-for-agent

- [ ] 对照两份调研文档补齐终止语义：opencode `core/src/tool/plugin/shell.ts` 的 kill 语义与 `util/src/cross-spawn-spawner.ts` 的树杀；codex `exec-server` 的 `Terminate`/`Signal` RPC 形状（`docs/research/codex-reusable-parts.md` §2.6、`docs/research/opencode-reusable-parts.md` §1/§3，缺的补进对应章节）
- [ ] 列出契约入口候选并给出推荐：新增第 9 个工具 `job_kill` / 在 `job_start` 或 `job_output` 上加可选参数 / 其他；逐个说明对「8 个工具的名字和参数是已发布契约，一个都不能改」这条硬边界的影响
- [ ] 定执行器侧改动范围：`job_kill` op 的形状、终止后任务状态与缓冲怎么收敛成 `exited`、树终止怎么复用 07 现状（Job Object + taskkill /T /F 双保险）
- [ ] 定测试入口与验收草案：只走 MCP 客户端入口，先写会变红的测试；验收至少覆盖「杀运行中任务返回终止确认、任务状态收敛、树内孙进程不死透不收工」
- [ ] 调研结论落成 Markdown 进 `docs/research/`，并在本票 Comments 里给出推荐方案与验收草案，等小白点头后才开实现票（实现票不预先创建）

**边界提醒：** 8 工具契约动不了的硬边界仍在；调研的产出之一就是回答「这个约束下终止入口放哪最不伤」。07 号票的已知边界照旧：执行器主循环串行，`job_kill` 若做成协议 op 也要接受与长 `bash` 排队的事实，调研时一并评估要不要在这张票里顺带处理。
