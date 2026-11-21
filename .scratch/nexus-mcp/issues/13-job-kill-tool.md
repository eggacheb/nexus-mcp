# 13: `job_kill` 工具：终止单个后台任务

**What to build:** 模型能主动终止一个还在跑的后台任务：调 `job_kill(job_id)` 立即拿到 killed 回执（不等进程退出），执行器树级硬杀该任务（Job Object + taskkill /T /F 双保险），detached 孙进程一并死透；随后 `job_output` 查询收敛为 exited（非 0 退出码），既有输出缓冲照常可读。8 个已发布工具的名字和参数不动，`job_kill` 是第 9 个纯增量工具。方案与拍板记录：`docs/research/job-kill.md` §3/§4/§7。

**Blocked by:** None（票 12 调研已拍板）

**Status:** ready-for-agent

- [ ] 红先写：实现前 MCP 客户端调 `job_kill` 报 unknown tool；改 src 先 `npm run build`（stdio 测试 spawn 的是 dist/index.js）；测试只走 MCP 客户端入口（`tests/jobs.test.ts` 的 connectStdio + callTool 模式）
- [ ] 杀运行中任务返回终止回执：`job_start` 一个 `sleep 30`，`job_kill` 立即返回 killed=true（status=running，不等进程退出）；随后 `job_output` 轮询到 status=exited 且 exit_code 非 0
- [ ] 已退出任务再杀：返回 killed=false + 已记录退出码，不报错（模型能区分「我杀了它」和「它本来结束了」）
- [ ] 未知 job_id：返回明确错误，形状与 job_output 一致
- [ ] 树内孙进程不死透不收工：`job_start` 派生 detached 孙进程（`nohup ping -n 60 127.0.0.1 >/dev/null 2>&1 &`，用 Windows 原生 ping 避开 MSYS pid 与 Windows pid 不一致），`job_kill` 后经 bash/tasklist 断言 ping.exe 已消失；若并发测试文件可能引入同名进程，换 `ps -W` 按 WINPID 精确断言
- [ ] 输出缓冲不回归：杀后 `job_output` 仍能读到既有输出，增量读取不重复
- [ ] Rust 侧 registry.kill 单测（SPAWN_LOCK 串行模式，照 jobs_tests.rs 的 kill_all_running_terminates_jobs）：覆盖运行中（killed=true）/已退出（killed=false）/未知 id（错误）三分支，收敛照旧轮询；`kill_all_running` 回归不变

**已知边界：** 执行器主循环串行，`job_kill` 会排在长前台 `bash` 后面（07 票面已记录）；回执式下 handler 无额外等待，不放大该边界，改并发另行开票。

**拍板记录（2026-11-21）：** 入口选 A（第 9 个工具，字面读法、纯增量）；op 形状取 codex 回执式（立即返回 killed 回执，退出确认靠 job_output 轮询，否掉了「有界等待 ≤2s 一次收口」的推荐）；被杀任务复用 `exited` 不设第三态，响应里用 killed 布尔区分；串行排队本票不处理。
