# 02: 执行层 stdio 多路并发、双车道调度与按文件写锁

**What to build:** 按 ADR-0011 将**协议层**与**执行层**之间的 stdio 单行 JSON 通道从全局串行升级为按请求 `id` 多路并发，落地 `control` / `ordinary` 双车道有界并发、单写线程响应写回、超时隔离与进程内按文件路径细粒度写锁，彻底消除慢 `bash`/`grep` 导致的队头阻塞与同文件并发写竞态。

**Blocked by:** None (可立即开工)

**Status:** done

- [x] **协议层** `ExecutorClient` 移除全局串行队列，支持按自增 `id` 并发发送请求并准确路由响应；单请求超时仅 reject 该请求并记录日志，不再 `close()` 杀掉整个执行器进程或误杀并发请求与运行中的**后台任务**。
- [x] **执行层**用纯标准库实现双车道并发：`control` 车道（`ping`、`job_kill`、无等待 `job_output`）独立放行不被慢请求饿死；`ordinary` 车道（其余工具）受有界信号量保护（默认上限 16）；所有响应经单一 `mpsc` 通道由专用写线程顺序 `writeln! + flush` 到 `stdout`，高并发下无 JSON 行交错。
- [x] **执行层**实现按归一化绝对路径（Windows 大小写折叠）的进程内 `KeyedMutex` 写锁，并在引用归零时自动清理条目；`write` 与 `edit` 的「读 → 匹配/准备 → 落盘」在同文件上严格串行，不同文件之间、读与写之间及 `bash` 之间可自由并发。
- [x] 当 `stdin` 关闭（协议层断开）时，执行层置位关闭标志、中止阻塞中的 `bash` 并统一树杀运行中的**后台任务**，不留孤儿进程。
- [x] 通过 Rust 单元测试与 MCP 客户端端到端测试（`tests/mcp.test.ts`、`tests/bash.test.ts`、`tests/edit.test.ts`、`tests/jobs.test.ts`）验收：慢 `bash` 运行期间并发 `read` / `ping` / `job_kill` 毫秒级返回、同文件并发 `edit`/`write` 无丢改动且不报错破坏文件、单请求超时不影响同执行器内正在运行的**后台任务**。

## Comments

- 验收清单 1 → `tests/mcp.test.ts > 执行层多路并发与按文件写锁 > 慢 bash 执行期间并发 read 不被队头阻塞`、`单请求超时仅 reject 当前请求，不误杀同执行器内的后台任务`
- 验收清单 2 → `crates/executor/src/main_tests.rs > lane_classification_routes_control_ops_separately_from_ordinary`、`tests/mcp.test.ts > 执行层多路并发与按文件写锁 > 慢 bash 执行期间并发 read 不被队头阻塞`
- 验收清单 3 → `crates/executor/src/main_tests.rs > concurrent_edits_same_file_do_not_lose_updates`（含锁表归零校验）、`tests/mcp.test.ts > 执行层多路并发与按文件写锁 > 同一文件并发 edit 自动串行不丢改动`
- 验收清单 4、5 → `tests/mcp.test.ts`（9/9 通过）与后续全量 `npm.cmd run check`（覆盖 `tests/panel.test.ts`、`tests/jobs.test.ts`、`tests/bash.test.ts`、`tests/edit.test.ts` 的退出树杀回归）
