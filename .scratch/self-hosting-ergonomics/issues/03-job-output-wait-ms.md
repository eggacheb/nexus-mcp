# 03: `job_output` 支持短等待（`wait_ms`）

**What to build:** 为 `job_output` 工具增加可选参数 `wait_ms`（默认 `0`、上限 `30_000`），让模型跟进长耗时**后台任务**时可以在单次调用内等待任务退出或新输出合并防抖后提前返回，减少空转轮询且不阻塞其他工具。

**Blocked by:** 02 (执行层 stdio 多路并发、双车道调度与按文件写锁)

**Status:** done

- [x] `job_output` MCP 工具 schema 与执行层协议新增可选整数参数 `wait_ms`（范围 `0..=30_000`，默认 `0`）；不传或传 `0` 时与既有行为 100% 一致，立刻返回。
- [x] 当 `wait_ms > 0` 且任务仍在运行、请求 `offset` 处尚无新可读字节时，执行层进入短等待；若任务提前退出则立即唤醒返回最终输出与退出码，若产生新输出则经短暂防抖（约 200ms，不超出总 `wait_ms` 上限）后提前返回增量输出。
- [x] 带等待（`wait_ms > 0`）的 `job_output` 归入 `ordinary` 车道，等待期间不阻塞 `control` 车道的 `ping` / `job_kill` / 无等待 `job_output`，也不阻塞并发 `read` / `edit`；协议层 IPC 超时预算随 `wait_ms` 放宽以避免客户端误超时。
- [x] 当 `stdin` 关闭或任务被 `job_kill` 终止时，正在等待的 `job_output` 迅速收敛返回，不挂死。
- [x] 通过 Rust `jobs_tests` 与 MCP 客户端入口（`tests/jobs.test.ts`）验证：默认 `wait_ms=0` 兼容、退出立返、新输出提前唤醒、超时无新输出正常返回以及等待期间并发 `job_kill` 立即生效。

## Comments

- 验收清单 1、2、3、4、5 → `tests/jobs.test.ts > job_kill 工具 > job_output 支持 wait_ms：任务提前退出立刻返回，新输出提前唤醒，且等待期间不阻塞并发 job_kill`、`crates/executor/src/main_tests.rs > lane_classification_routes_control_ops_separately_from_ordinary`、`crates/executor/src/jobs_tests.rs`（14/14 通过）
