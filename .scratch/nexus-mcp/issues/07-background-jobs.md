# 07: 后台任务

**What to build:** 构建、测试这类跑几分钟的命令不再把工具调用卡死。`job_start` 立刻返回一个 id，`job_output` 随时增量读取已经产生的输出，任务结束后能查到退出码，服务退出时不留孤儿进程。

**Blocked by:** 03

**Status:** ready-for-agent

- [ ] `job_start` 在 200 毫秒内返回 `job_id`，不被命令本身阻塞
- [ ] `job_output` 支持按字节偏移增量读取，重复调用不重复返回同一段内容
- [ ] 任务运行中查询返回当前状态（运行中）与已有输出
- [ ] 任务结束后查询返回退出码与最终状态
- [ ] 输出采用有界缓冲，超长时保留头尾并标注省略量
- [ ] 不存在的 `job_id` 返回明确错误，不返回空结果
- [ ] 服务退出时终止所有后台任务，不残留子进程
- [ ] 同一 `job_start` 连续启动多个任务时 id 不冲突
- [ ] 任务结束时释放句柄，长时间运行不累积内存

**复用来源：** 只抄 codex `exec-server` 的进程事件模型形状（`ExecProcess`、`ExecProcessEvent`、`ProcessOutputChunk`，见 `docs/research/codex-reusable-parts.md` §2.6），**不要**把 `codex-exec-server` 加进依赖：它 166 个源文件，还要拖 tonic、tungstenite、otel、rama。输出缓冲用票 03 已经搬进来的 `head-tail-buffer`，不要另写一套。opencode 侧参考：`core/src/tool/plugin/shell.ts` 的「前台超时不杀、转后台并通知模型」语义与后台输出写文件 + tail 截断；`util/src/cross-spawn-spawner.ts:440-497` 的 Windows 树杀（`taskkill /T /F`）与脱离子进程挂 stdio 的关泵时序坑；Rust 侧对照 `process-daemon/src/service/pipe/windows.rs` 的 Job Object（`JOB_OBJECT_KILL_ON_JOB_CLOSE` + `TerminateJobObject`）加固进程树终止，只摘这一个文件、不引入 portable-pty。见 `docs/research/opencode-reusable-parts.md` §1 与 §3。
