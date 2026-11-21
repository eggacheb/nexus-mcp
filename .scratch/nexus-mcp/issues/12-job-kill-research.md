# 12: `job_kill` 调研：单个后台任务的终止入口

**What to build:** 模型能主动终止一个还在跑的后台任务（跑挂的构建、测试）。07 号票已把执行器侧地基铺好（Job Object、`TerminateJobObject`、任务注册表、退出时 kill_all），但 8 工具契约下模型没有任何入口能杀单个任务——只能等它自己结束或整个服务退出。本票先调研定方案，调研通过后另开实现票。

**Blocked by:** None（07 已 done）

**Status:** done

- [x] 对照两份调研文档补齐终止语义：opencode `core/src/tool/plugin/shell.ts` 的 kill 语义与 `util/src/cross-spawn-spawner.ts` 的树杀；codex `exec-server` 的 `Terminate`/`Signal` RPC 形状（`docs/research/codex-reusable-parts.md` §2.6、`docs/research/opencode-reusable-parts.md` §1/§3，缺的补进对应章节）
- [x] 列出契约入口候选并给出推荐：新增第 9 个工具 `job_kill` / 在 `job_start` 或 `job_output` 上加可选参数 / 其他；逐个说明对「8 个工具的名字和参数是已发布契约，一个都不能改」这条硬边界的影响
- [x] 定执行器侧改动范围：`job_kill` op 的形状、终止后任务状态与缓冲怎么收敛成 `exited`、树终止怎么复用 07 现状（Job Object + taskkill /T /F 双保险）
- [x] 定测试入口与验收草案：只走 MCP 客户端入口，先写会变红的测试；验收至少覆盖「杀运行中任务返回终止确认、任务状态收敛、树内孙进程不死透不收工」
- [x] 调研结论落成 Markdown 进 `docs/research/`，并在本票 Comments 里给出推荐方案与验收草案，等小白点头后才开实现票（实现票不预先创建）

**边界提醒：** 8 工具契约动不了的硬边界仍在；调研的产出之一就是回答「这个约束下终止入口放哪最不伤」。07 号票的已知边界照旧：执行器主循环串行，`job_kill` 若做成协议 op 也要接受与长 `bash` 排队的事实，调研时一并评估要不要在这张票里顺带处理。

## Comments

**调研（2026-11-21）：**

- 补记两份调研文档：`codex-reusable-parts.md` §2.6 新增 Terminate/Signal RPC 形状小节（方法名、Params/Response 字段、「回执 + 幂等」语义、Windows Job Object 树杀、输出收尾、启示）；`opencode-reusable-parts.md` §1 补 kill 语义（模型侧无终止入口、`stop` 仅用户打断可达、`shell.remove` 是销毁）、树杀 fallback 链与信号升级、「不死透不收工」的 close/管道语义、状态收敛对照。§3 的 Job Object 内容 07 已覆盖，无需补。
- 调研结论落盘：`docs/research/job-kill.md`（§1 背景与硬边界、§2 对位事实、§3 入口候选 A/B/C/D 对比、§4 执行器改动范围、§5 串行排队评估、§6 测试入口与验收草案、§7 拍板清单）。
- 验收清单对应物（本票是调研票、无测试用例，对应物为文档章节）：第 1 条 → 两份文档的票 12 补记章节；第 2 条 → job-kill.md §3（推荐 A：第 9 个工具 `job_kill`，8 个已发布工具名字/参数不动）；第 3 条 → job-kill.md §4（op 形状、Exited 收敛复用监控线程、`terminate_tree` 原样复用、win_job.rs 零改动）；第 4 条 → job-kill.md §6（MCP 客户端入口 + 红先写 + 6 条验收草案）；第 5 条 → 本 Comments + 上述落盘文件。
- **待拍板 4 项**（job-kill.md §7）：① 入口选型与契约读法（推荐 A）；② op 形状（推荐有界等待 ≤2s 一次收口，备选 codex 回执式）；③ 被杀任务状态词（推荐复用 `exited`，不设第三态）；④ 串行排队不顺带处理。实现票不预先创建，拍板后按 `/to-tickets` 拆。
- **拍板（2026-11-21）**：① 入口 A（第 9 个工具 `job_kill`，字面读法、纯增量）；② op 形状取 **codex 回执式**（否掉有界等待推荐）；③ 复用 `exited` 不设第三态；④ 串行排队不处理。实现票：`13-job-kill-tool.md`。
