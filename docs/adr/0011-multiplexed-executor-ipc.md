# 执行层 stdio 多路并发、双车道调度与按文件写锁

Status: accepted

此前**协议层**（`src/executor.ts`）用全局串行队列发送请求、**执行层**（`crates/executor/src/main.rs`）单线程顺序执行，导致一次耗时较长的 `bash` 或大目录 `grep` 会堵死所有并发的 `read` / `edit` / `glob` / `job_output` 调用，且单请求超时会直接关闭整个执行器进程、误杀正在运行的**后台任务**。现决定将 stdio 单行 JSON 通道升级为按请求 `id` 多路并发：协议层移除全局串行队列并按 `id` 路由响应、单请求超时仅 reject 当前请求；执行层使用纯标准库实现**双车道有界并发**（参考 `codex` `exec-server` 的 `RequestLanes`：`control` 车道服务 `ping`、`job_kill` 与无等待 `job_output`，永不被慢请求饿死；`ordinary` 车道设默认 16 并发上限，服务其余工具与带 `wait_ms` 的 `job_output`），所有响应经单一 `mpsc` 通道由专用写线程顺序写入 `stdout`，并对同一文件路径的 `write` / `edit` 事务加进程内按路径细粒度锁（参考 `opencode` 的 `KeyedMutex`，Windows 大小写折叠、引用归零自动清理）。

## Considered Options

- **继续保持全局串行，只靠模型自己把长命令全放进 `job_start`**：无法解决中短耗时 `bash`（5–30 秒）与并行 `read` / `grep` 的队头阻塞，且多会话并发调用仍会互相卡死。
- **裸多线程并发（不分车道、不加文件锁）**：一堆慢请求打满并发槽时会饿死 `ping` 与 `job_kill`；模型同一轮并发对同一文件发起两次 `edit` 时会发生「读-改-写」竞态覆盖。
- **引入 `tokio` 异步运行时重做执行层**：为单机本地执行器引入完整异步栈会显著增加编译体积与依赖复杂度；纯标准库线程 + 信号量 + 单通道写回即可满足 16 级并发需求。
- **全局 `RwLock`（只读并发、写与 `bash` 独占）**：参考 `codex` Agent 侧 `parallel.rs`，但在 MCP 服务端会导致一个 `bash` 再次堵死所有并行的只读查询与无关文件编辑。

## Consequences

- `ExecutorClient` 单请求超时后不再主动 `close()` 整个执行器进程，仅在子进程真实退出或健康探测失败时重建，避免误杀并发中的工具调用与**后台任务**。
- `write` / `edit` 在同文件上严格串行，不同文件之间、读写之间与 `bash` 之间可自由并发；外部进程对同一文件的竞争仍不在此锁覆盖范围内。
- 执行层新增的 `job_output` 短等待（`wait_ms`）走 `ordinary` 车道，确保等待期间不会阻塞 `ping` / `job_kill` 等控制类请求。
