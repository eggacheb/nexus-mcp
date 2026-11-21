# 13: `job_kill` 工具：终止单个后台任务

**What to build:** 模型能主动终止一个还在跑的后台任务：调 `job_kill(job_id)` 立即拿到 killed 回执（不等进程退出），执行器树级硬杀该任务（Job Object + taskkill /T /F 双保险），detached 孙进程一并死透；随后 `job_output` 查询收敛为 exited（非 0 退出码），既有输出缓冲照常可读。8 个已发布工具的名字和参数不动，`job_kill` 是第 9 个纯增量工具。方案与拍板记录：`docs/research/job-kill.md` §3/§4/§7。

**Blocked by:** None（票 12 调研已拍板）

**Status:** done

- [x] 红先写：实现前 MCP 客户端调 `job_kill` 报 unknown tool；改 src 先 `npm run build`（stdio 测试 spawn 的是 dist/index.js）；测试只走 MCP 客户端入口（`tests/jobs.test.ts` 的 connectStdio + callTool 模式）
- [x] 杀运行中任务返回终止回执：`job_start` 一个 `sleep 30`，`job_kill` 立即返回 killed=true（status=running，不等进程退出）；随后 `job_output` 轮询到 status=exited 且 exit_code 非 0
- [x] 已退出任务再杀：返回 killed=false + 已记录退出码，不报错（模型能区分「我杀了它」和「它本来结束了」）
- [x] 未知 job_id：返回明确错误，形状与 job_output 一致
- [x] 树内孙进程不死透不收工：`job_start` 派生 detached 孙进程（`nohup ping -n 60 127.0.0.1 >/dev/null 2>&1 &`，用 Windows 原生 ping 避开 MSYS pid 与 Windows pid 不一致），`job_kill` 后经 bash/tasklist 断言 ping.exe 已消失；若并发测试文件可能引入同名进程，换 `ps -W` 按 WINPID 精确断言
- [x] 输出缓冲不回归：杀后 `job_output` 仍能读到既有输出，增量读取不重复
- [x] Rust 侧 registry.kill 单测（SPAWN_LOCK 串行模式，照 jobs_tests.rs 的 kill_all_running_terminates_jobs）：覆盖运行中（killed=true）/已退出（killed=false）/未知 id（错误）三分支，收敛照旧轮询；`kill_all_running` 回归不变

**已知边界：** 执行器主循环串行，`job_kill` 会排在长前台 `bash` 后面（07 票面已记录）；回执式下 handler 无额外等待，不放大该边界，改并发另行开票。

**拍板记录（2026-11-21）：** 入口选 A（第 9 个工具，字面读法、纯增量）；op 形状取 codex 回执式（立即返回 killed 回执，退出确认靠 job_output 轮询，否掉了「有界等待 ≤2s 一次收口」的推荐）；被杀任务复用 `exited` 不设第三态，响应里用 killed 布尔区分；串行排队本票不处理。

## Comments

**实现（2026-11-22）：**

- 协议加 `job_kill { id, job_id }` → `{ ok, job_id, killed, status, exit_code }`。回执式：`JobRegistry::kill` 读到 Running 就 `Job::terminate_tree`（TerminateJobObject + taskkill /T /F，`win_job.rs` 零改动）后立刻返回 `killed=true / status=running / exit_code=null`；读到 Exited 直接返回 `killed=false` + 已记录退出码。收敛全交给监控线程，不另设状态机。
- `job_id` 解析抽成 `resolve_job`，`output` 与 `kill` 共用，未知 id / 格式错误的文案与 job_output 完全一致（job_output 的对外文案一字未改，原单测照旧绿）。
- TS 侧 `JobKillSuccess` 类型 + 第 9 个工具 `job_kill`；8 个已发布工具的名字与参数未动。回执文本头 `killed:` / `status:` / `exit_code:` 与 job_output 同形，正文「已终止 job-N 的进程树。用 job_output 确认退出码。」/「job-N 已经结束（exit_code: X），无需终止。」。
- 工具计数文案同步为 9：`AGENTS.md` 工具清单、`src/oauth.ts` 授权页、`tests/{mcp,http,panel,oauth-http}.test.ts` 的清单与计数断言。`docs/tunnel.md` 的「实测显示 8 个工具」是历史实测记录，保留原样。
- 红测试证据：实现前 5 条新用例全红在 `MCP error -32602: Tool job_kill not found`；`npm run build` 后转绿。

验收对应用例：

- 杀运行中任务：`tests/jobs.test.ts`「杀运行中任务：立即返回 killed=true 回执，状态与退出码靠 job_output 收敛」（回执 <2s、killed=true、status=running、exit_code=null；随后轮询到 exited 且 exit_code≠0）
- 已退出再杀：`tests/jobs.test.ts`「杀已退出任务：killed=false + 已记录退出码，不报错」
- 未知 job_id：`tests/jobs.test.ts`「未知 job_id：报错形状与 job_output 一致」；Rust `kill_unknown_job_id_is_a_clear_error`、`kill_malformed_job_id_is_a_clear_error`
- 孙进程死透：`tests/jobs.test.ts`「树内 detached 孙进程随任务一起终止」——System32 的 PING.EXE 拷成唯一映像名 `nexus-kill-grandchild.exe`，`nohup` detached 起，`tasklist` 按映像名计数在 15s 内归零（实测约 5s）。选唯一映像名而非 `ps -W` 按 WINPID：并行测试文件零干扰，也不用解析 MSYS pid
- 输出缓冲不回归：`tests/jobs.test.ts`「杀后既有输出照常可读，增量读取不重复」；Rust `kill_running_job_returns_receipt_then_converges_to_exited` 同时断言 `keep-me` 仍在缓冲
- Rust 三分支 + 回归：`kill_running_job_returns_receipt_then_converges_to_exited` / `kill_finished_job_returns_recorded_exit_code` / `kill_unknown_job_id_is_a_clear_error`；`kill_all_running_terminates_jobs` 未改、照旧通过
- 全量：`npm run check` 绿（vitest 12 文件 120 条、cargo 112 条、smoke 报「工具数量: 9」）
