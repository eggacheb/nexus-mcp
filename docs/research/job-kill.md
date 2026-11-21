# job_kill 终止入口调研（票 12）

2026-11-21 调研完成，同日拍板（结果见 §7）。实现票：`.scratch/nexus-mcp/issues/13-job-kill-tool.md`。
本票同步补记两份对位调研文档：`codex-reusable-parts.md` §2.6（Terminate/Signal RPC 形状）、`opencode-reusable-parts.md` §1（kill 语义与树杀细节）；opencode §3 的 Job Object 内容 07 已覆盖，无需补。

## 1. 背景与硬边界

- 8 工具契约：「8 个工具的名字和参数是已发布契约，一个都不能改」。
- 07 地基（已在 `crates/executor/` 核实）：`win_job.rs` Job Object（`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`，assign 失败降级普通进程）、`jobs.rs` JobRegistry（id 自增、监控线程 10ms `try_wait` 轮询、退出后 500ms 宽限等输出泵、finished 上限 50）、`Job::terminate_tree`（`jobs.rs:80-89`，TerminateJobObject + `kill_process_tree` 兜底）、`kill_process_tree`（`main.rs:797-808`，taskkill /PID /T /F + `child.kill()`）、退出时 `kill_all_running`（`main.rs:840-845`）。
- 缺口：模型没有任何入口杀单个任务——协议只有 `job_start`/`job_output` 两个 job op，工具面没有 kill 类工具。
- 已知边界：执行器主循环串行（`main.rs:822-846` `for line in stdin.lock().lines()`），TS `ExecutorClient` 也 promise 链串行排队（`src/executor.ts:170-181`）；长前台 `bash` 期间所有 op 排队（07 Comments 已记录）。

## 2. 对位调研事实

1. **codex**：terminate 是「回执 + 异步通知」——`TerminateResponse { running: bool }` 立即返回，退出确认走 `process/exited` → `process/closed` 通知；对已退出/未知 id 幂等 no-op 不报错；Windows 树杀 Job Object 优先、单进程 TerminateProcess 兜底。详见 `codex-reusable-parts.md` §2.6 票 12 补记。
2. **opencode**：模型侧根本没有终止入口——工具参数无 kill、服务层 `stop` 只有「调用未返回时的用户打断」可达、HTTP `shell.remove` 是销毁不是终止；树杀 `taskkill /T /F` 无重试、失败直接 fallback 单进程 kill、SIGTERM → 3s → SIGKILL 升级；detached 孙进程持有管道会让 `close` 永不触发（1s deadline 关泵 + drain）。详见 `opencode-reusable-parts.md` §1 票 12 补记。
3. **process-daemon**（opencode 的 Rust 侧守护）的 Job Object 用法 07 已抄对（KILL_ON_JOB_CLOSE + TerminateJobObject + 失败兜底 Terminate），`opencode-reusable-parts.md` §3 无新增。
4. **结论**：job_kill 在两边都没有现成形状可搬；能借的是 codex 的「回执 + 幂等」协议语义与两家的「树杀双保险」实现模式——树杀我们 07 已经落地，本次只剩协议入口与收敛语义要自己定。

## 3. 契约入口候选与推荐

| 候选 | 对「8 工具契约」的影响 | 语义与安全 | 结论 |
|---|---|---|---|
| **A. 新增第 9 个工具 `job_kill(job_id)`** | 8 个已发布工具的名字/参数/描述一字不动，已有调用全部照旧；但工具清单从 8 变 9——若按最严读法（暴露面冻结为恰好 8 个）则算改契约，需重新发布清单 | 终止是独立动作，与 job_start/job_output 成三件套；描述一句话、参数 1 个，符合「工具描述要短、参数要少」 | **推荐**；契约按哪种读法理解待拍板 |
| B. `job_output` 加可选参数（如 `action: "kill"`） | 直接改已发布工具的参数 schema——字面上就是被禁的那类改动；可选参数 wire 向后兼容也救不回「参数不能改」 | 一个工具两个动作，「读输出」与「杀进程」混在一起，误触风险高；codex/opencode 均无此形状 | 排除（除非公开修订 job_output 契约） |
| C. `job_start` 加可选参数 | 同 B | 创建时参数表达不了「终止一个已经跑起来的任务」；复用调用表达终止比 B 更扭曲 | 排除 |
| D. 不加入口，模型用 `bash` 敲 `taskkill /PID <pid> /T /F`（pid 来自 job_start 返回） | 零，今天就能用 | pid 复用风险：模型在任务退出后再杀，Windows pid 可能已回收，会误杀无关进程；靠模型记住 OS 命令，跨平台没对齐路径；杀的时点与退出码语义游离在执行器外，测试只能测「模型碰巧敲对」；生命周期操作藏在 bash 字符串约定里，契约等于没覆盖 | 记为应急 workaround，不做正式方案 |

**推荐 A**：四个候选里唯一「语义干净 + 对已发布集成零破坏」的方案。MCP `tools/list` 是动态枚举，集成方重新拉清单会多看到一项工具，已有 8 个工具的调用不受影响。硬边界的字面（8 个工具的名字和参数不动）A 完全满足；最严读法（暴露面恰好 8 个）下 A 属于改契约——这正是留给小白拍板的点。

## 4. 执行器侧改动范围（按候选 A 展开）

### 协议 op `job_kill`

- **请求**：`{ id, job_id }`，没有别的参数。不加 force/graceful 开关：Windows 侧 Job Object + taskkill /T /F 本来就是硬杀，graceful 在这个协议里没有可实现的通道（不往子进程 stdin 写东西）。codex 的 `ProcessSignal` 也收缩到只剩 `Interrupt` 一个变体，我们直接不设软信号。
- **响应（拍板：codex 回执式，2026-11-21）**：立即返回，不等进程退出——`{ id, ok, job_id, killed: bool, status: "running"|"exited", exit_code: Option<i32> }`
  - 杀运行中任务：`terminate_tree` 后立即返回 `killed=true` + `status="running"`（exit_code=null）；退出确认由监控线程收敛（10ms 轮询 `try_wait`），模型随后用 `job_output` 查到 status=exited + 非 0 退出码。
  - 杀已退出任务：返回 `killed=false` + `status="exited"` + 已记录退出码，不报错（幂等，且让模型能区分「我杀了它」和「它本来结束了」）。
  - 未知 `job_id`：`{ ok: false, error: "..." }`，形状与 `job_output` 的错误一致。不学 codex 的静默 no-op——那是内部清理路径；这里是模型可达的工具调用，unknown id 大概率是 id 抄错或任务已被 50 条上限淘汰，要给明确错误。
  - 回执式下 handler 无等待逻辑，注册表锁一进一出即可；原为有界等待准备的「等待期间不持锁」注意事项作废。

### 状态与缓冲收敛

- 收敛完全复用监控线程（`jobs.rs:352-364`，10ms `try_wait` 轮询 + 退出后 500ms 宽限等输出泵收尾），job_kill 不另设状态机；被杀任务与自然退出同走 `Exited { exit_code }`。
- **不引入 `killed` 第三态**（对照 opencode 有 `timeout|killed`）：「被 job_kill 杀」与「命令自己非 0 退出」对模型都是 died non-zero，输出缓冲与状态字段保持现状，模型视图少一个词。此项与响应里的 `killed: bool` 字段无关（后者只表示「本次调用完成了终止」）。
- 输出缓冲不动：head-tail-buffer 原样保留，杀完的尾部输出照常经 500ms 宽限落进缓冲，`job_output` 可继续读到。

### 树终止复用

- `Job::terminate_tree`（`jobs.rs:80-89`）原样用：Windows 先 TerminateJobObject（覆盖已入 job 的全部后代，**含 detached 孙进程**——07 的 Job Object 就是为此铺的），再 `kill_process_tree` 兜底（覆盖 assign 失败降级为普通进程的场景）。`win_job.rs` 零改动。
- 新增面：`main.rs` 加一个 op 分支（照 job_start/job_output 的反序列化 → 同步调用形状）；`JobRegistry` 加 `kill(job_id) -> Value` 方法（与 `kill_all_running` 共享 terminate_tree 与轮询节奏）。

### TS 侧

- `src/executor.ts` 加 `JobKillResponse` 类型与 client 方法（排队机制现成；回执式下 job_kill 立即返回，不占 deadline）。
- `src/tools.ts` 注册第 9 个工具 `job_kill`（参数只要 `job_id`），描述一句话「终止一个还在跑的后台任务」；返回文本「已请求终止 job-N，用 job_output 查询退出状态」/「job-N 已经结束（exit code X），无需终止」；错误文案与 job_output 对齐。

## 5. 串行排队评估（要不要顺带处理）

**不顺带处理。** 理由：

1. 排队根因是主循环串行，07 已在票面记录；要解决得让 job 类 op 移出主循环线程，是协议并发化，超出本票。
2. job_kill 自身新增的 ≤2s 有界等待只在轮到它之后发生，量级与一次 bash 冷启动相当，不放大排队问题。
3. 将来 job 类工具用得多了、排队可感，单独开「执行器并发」票；现状先把这个边界照旧写进实现票的「已知边界」。

## 6. 测试入口与验收草案（实现票用）

- **入口**：只走 MCP 客户端（`tests/jobs.test.ts` 的 `connectStdio` + `callTool` 模式）。红先写：实现前 `callTool("job_kill")` 必须报 unknown tool，这条红测试先落再加实现变绿。改 src 先 `npm run build`（stdio 测试 spawn 的是 `dist/index.js`）。
- **验收草案**：
  1. [ ] 杀运行中任务返回终止回执：`job_start` 一个 `sleep 30`，`job_kill` 立即返回 killed=true（status=running，不等进程退出）；随后 `job_output` 轮询到 status=exited 且 exit_code 非 0，增量读取不重复
  2. [ ] 任务状态收敛：杀后 `job_output` 的 status/exit_code 与监控线程收敛结果一致（轮询拿到，job_kill 不等待）
  3. [ ] 树内孙进程不死透不收工：`job_start` 一个派生 detached 孙进程的 bash（`nohup ping -n 60 127.0.0.1 >/dev/null 2>&1 &`，ping 是 Windows 原生进程，避开 MSYS pid 与 Windows pid 不一致），`job_kill` 后经 bash/tasklist 断言 ping.exe 已消失——Job Object 覆盖 detached 后代是 07 地基的关键验收；若并发测试文件可能引入同名进程，换 `ps -W` 按 WINPID 精确断言
  4. [ ] 已退出任务再杀：返回已结束确认（不报错），killed=false
  5. [ ] 未知 job_id：明确错误，形状与 job_output 一致
  6. [ ] Rust 侧 registry.kill 单测（SPAWN_LOCK 模式，照 `kill_all_running_terminates_jobs`，`jobs_tests.rs:265-286`），覆盖运行中/已退出/未知 id 三分支；`kill_all_running` 回归不变

## 7. 拍板记录（2026-11-21，小白已定）

1. **契约入口**：A——新增第 9 个工具 `job_kill`，8 个已发布工具的名字和参数不动，按字面读法、纯增量。
2. **`job_kill` op 形状**：**codex 回执式**——立即返回 `killed` 回执，退出确认靠模型 `job_output` 轮询（「有界等待 ≤2s 一次收口」的推荐被否掉）。
3. **被杀任务的状态词**：复用 `exited` 不设第三态；响应里的 `killed` 布尔区分「我杀了它」。
4. **串行排队**：本票不顺带处理，边界照旧记录在实现票。

实现票：`.scratch/nexus-mcp/issues/13-job-kill-tool.md`。
