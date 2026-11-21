# 07: 后台任务

**What to build:** 构建、测试这类跑几分钟的命令不再把工具调用卡死。`job_start` 立刻返回一个 id，`job_output` 随时增量读取已经产生的输出，任务结束后能查到退出码，服务退出时不留孤儿进程。

**Blocked by:** 03

**Status:** done

- [x] `job_start` 在 200 毫秒内返回 `job_id`，不被命令本身阻塞
- [x] `job_output` 支持按字节偏移增量读取，重复调用不重复返回同一段内容
- [x] 任务运行中查询返回当前状态（运行中）与已有输出
- [x] 任务结束后查询返回退出码与最终状态
- [x] 输出采用有界缓冲，超长时保留头尾并标注省略量
- [x] 不存在的 `job_id` 返回明确错误，不返回空结果
- [x] 服务退出时终止所有后台任务，不残留子进程
- [x] 同一 `job_start` 连续启动多个任务时 id 不冲突
- [x] 任务结束时释放句柄，长时间运行不累积内存

**复用来源：** 只抄 codex `exec-server` 的进程事件模型形状（`ExecProcess`、`ExecProcessEvent`、`ProcessOutputChunk`，见 `docs/research/codex-reusable-parts.md` §2.6），**不要**把 `codex-exec-server` 加进依赖：它 166 个源文件，还要拖 tonic、tungstenite、otel、rama。输出缓冲用票 03 已经搬进来的 `head-tail-buffer`，不要另写一套。opencode 侧参考：`core/src/tool/plugin/shell.ts` 的「前台超时不杀、转后台并通知模型」语义与后台输出写文件 + tail 截断；`util/src/cross-spawn-spawner.ts:440-497` 的 Windows 树杀（`taskkill /T /F`）与脱离子进程挂 stdio 的关泵时序坑；Rust 侧对照 `process-daemon/src/service/pipe/windows.rs` 的 Job Object（`JOB_OBJECT_KILL_ON_JOB_CLOSE` + `TerminateJobObject`）加固进程树终止，只摘这一个文件、不引入 portable-pty。见 `docs/research/opencode-reusable-parts.md` §1 与 §3。

## Comments

**实现（2026-11-21）：**

- 协议扩两个 op：`job_start`（command/cwd/shell/max_output_bytes → job_id + pid）与 `job_output`（job_id/offset/max_output_bytes → status/exit_code/output/next_offset/total_bytes/omitted_bytes）。job 状态与输出全在执行器内存管（票的复用要点已定缓冲在执行器，TS 只中转）；没有 job_kill op——退出清理走内部 kill_all，杀单个任务的诉求留给以后的票。
- `crates/executor/src/jobs.rs`：JobRegistry（id 自增、监控线程轮询 try_wait、退出后 500ms 宽限等输出泵收尾、finished 记录上限 50 按 id 数序淘汰释放句柄）；`job_output` 按 head/tail/丢弃段三段坐标映射增量切片，UTF-8 边界对齐复用 `truncated_prefix`/`aligned_tail`。
- `crates/executor/src/win_job.rs`：Job Object（KILL_ON_JOB_CLOSE）+ spawn 后立刻 AssignProcessToJobObject + TerminateJobObject；执行器被硬杀时 OS 兜底杀树。与 opencode 的差异：**没用 CREATE_SUSPENDED + 线程快照恢复**——实测让 job_start 慢到 300ms 级（超 200ms 验收线），改 spawn 后立刻 assign，竞态窗口微秒级（bash 的 MSYS 初始化要几十毫秒才可能派孙进程），显式杀树仍有 taskkill /T /F 兜底。
- 200ms 验收由 TS 测试热身后端到端断言（实测 ~100ms）；Rust 侧同断言在 cargo 并行测试负载下放宽到 1s，只验证「不等命令结束」。
- 已知边界：主循环是串行协议（一行一响应），若一条长 `bash` 正在跑，`job_start` 会在其后排队——不受命令**本身**阻塞，但会被并发的 bash 阻塞；改并发要动协议架构，超出本票范围。
