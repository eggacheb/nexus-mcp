# 自举调试与开发流畅度优化 规格

Status: ready-for-agent

## Problem Statement

当前通过 `nexus-mcp` 开展日常开发与「AI 自己调试、改代码并**热切换**」闭环时，主链路已可稳定运行，但存在四处直接影响流畅度的摩擦：

1. **执行层全局串行造成队头阻塞**：**协议层**通过全局串行队列向**执行层**发请求，**执行层**主循环也单线程顺序处理。只要有一条耗时 15–60 秒的 `bash` 或大目录 `grep` 正在运行，同一轮或并发会话发出的 `read`、`edit`、`glob`、`job_output`、`job_kill` 全部被堵死；且单请求在客户端侧超时时会直接关闭整个执行器进程，连带误杀并发请求与运行中的**后台任务**。
2. **`job_output` 缺少短等待导致轮询空转**：运行构建、全量测试或本地部署等 50–60 秒级**后台任务**时，`job_output` 每次调用都立刻返回，云端模型必须连续空转多轮工具调用或额外借助 `bash` `sleep`，浪费上下文与等待时间。
3. **热切换与运行期排障的最后一公里不够直观**：**热切换**触发后仅返回异步受理，具体成功或回滚记录写在**沙箱根**之外的运行目录日志文件里，无法通过 `read` 直接查看；`/health` 与 `/api/status` 缺少当前运行内核的构建指纹，热切完成后无法一眼确认连接的是否为刚编出的新版本；`/api/logs` 固定返回进程内最近 200 行且不支持过滤，高频调用后关键告警容易被冲掉。
4. **`write` 不自动创建缺失父目录**：每次在新建子目录中写文件时，都必须额外先执行一次 `bash` `mkdir -p`，增加往返并在受限**命令闸门**配置下产生不必要的 shell 依赖。

## Solution

严格保持现有 9 个 MCP 工具不变（不新增第 10 个工具），通过内部协议升级、极少可选参数和**面板**本地 HTTP 接口增强消除上述四处摩擦：

1. **执行层 stdio 多路并发、双车道调度与按文件写锁**（遵循 ADR-0011）：**协议层**移除全局串行队列并按请求 `id` 多路复用，单请求超时仅 reject 当前请求；**执行层**用纯标准库实现 `control` / `ordinary` 双车道有界并发与单写线程顺序写回 `stdout`，并对同文件路径的 `write` / `edit` 事务加进程内按路径细粒度写锁。
2. **`job_output` 短等待（`wait_ms`）**：为 `job_output` 增加可选 `wait_ms` 参数（默认 `0` 保持兼容，上限 `30_000`），任务退出立即返回，运行中出现新输出经短暂防抖（约 200ms）后提前返回，减少长任务轮询空转。
3. **运行指纹、热切换结果回显与 `/api/logs` 过滤增强**：`/health` 与 `/api/status` 返回当前运行内核的 `{ version, buildId, startedAt, pid }`；**托盘宿主**与本地切换脚本在每次**热切换**完成后将脱敏结果落盘为 `logs/last-hotswap.json`，由 `/api/status` 与 `/api/hotswap` 直接返回；进程内**服务日志**环扩至 1000 行，`/api/logs` 支持 `level` / `limit` / `q` 过滤（无参保持默认最近 200 行兼容前端）。
4. **`write` 自动创建沙箱内缺失父目录**：在严格通过词法越界检查与最深已存在祖先目录真实路径验根后，自动创建**沙箱根**内的缺失父目录，免去前置 `mkdir -p`。

## User Stories

1. 作为使用 `nexus-mcp` 调试项目的 AI 或开发者，我想在一条耗时较长的 `bash` 或 `grep` 执行期间，并发调用 `read`、`glob`、`edit`、`job_output` 或 `job_kill` 仍能立即得到响应，不被队头阻塞。
2. 作为并发编辑多个文件的 AI，我想对不同文件的 `write` / `edit` 能够并行完成，而对同一个文件的并发 `edit` / `write` 能够自动串行化，不会出现后写覆盖前写的竞态丢失。
3. 作为同时运行着**后台任务**的使用者，我想某个普通工具请求超时时仅该请求报错返回，不会把整个执行器进程连带其他并发请求和运行中的**后台任务**一起杀掉。
4. 作为观察长耗时构建或测试**后台任务**的 AI，我想在调用 `job_output` 时传入 `wait_ms`（如 15000 或 30000），在任务退出或产出新日志时提前返回，用 1–2 次调用就完成跟进而不是反复空轮询；不传 `wait_ms` 时保持立即返回。
5. 作为刚执行完本地**热切换**的使用者，我想调用一次本地 `/health` 或 `/api/status`（以及 `/api/hotswap`），就能直接看到当前运行的 `buildId`、`startedAt`、`pid` 与最近一次**热切换**的成功/回滚状态，无需跨越**沙箱根**去翻外部日志文件。
6. 作为排查运行期异常的使用者，我想对 `/api/logs` 传入 `level`、`limit`、`q` 参数，从更长的进程内日志缓冲中快速筛出告警或特定事件，同时不影响**面板**网页现有的日志展示。
7. 作为在新建子目录里创建代码或文档的使用者，我想直接调用 `write` 写入目标路径即可自动创建**沙箱根**内的缺失父目录，同时任何企图经由 `..` 或中间符号链接跳出**沙箱根**的写入仍被坚决拒绝。

## Implementation Decisions

### 1. 工具面与兼容性边界

- 严格保持 9 个 MCP 工具不变：`read`、`write`、`edit`、`bash`、`glob`、`grep`、`job_start`、`job_output`、`job_kill`。
- 仅在 `job_output` 增加一个可选整数参数 `wait_ms`（范围 `0..=30000`，默认 `0`）；其余 8 个工具的输入 schema 保持不变。
- 更新 `write` 工具说明与**面板**工具摘要，移除「不自动建目录」的旧提示。

### 2. 执行层多路并发、双车道调度与按文件写锁（ADR-0011）

- **协议层多路复用**：
  - 移除 `ExecutorClient` 的全局串行请求队列，直接按自增 `id` 写入 `stdin` 并通过 `pending` 表路由响应。
  - 单请求超时仅清理该 `id` 的等待项并 reject 对应 Promise、记错误日志，不再调用 `close()` 杀掉整个执行器进程；只有执行器进程异常退出、写入管道失败或显式关闭时才 failAll 并重建。
- **执行层双车道有界并发（纯标准库，不引入 `tokio`）**：
  - `control` 车道：服务 `ping`、`job_kill` 与无等待（`wait_ms == 0`）的 `job_output`，独立放行/独立配额，永不被慢请求饿死。
  - `ordinary` 车道：服务 `read`、`write`、`edit`、`glob`、`grep`、`bash`、`job_start` 与带等待（`wait_ms > 0`）的 `job_output`，通过标准库 `Mutex + Condvar` 信号量限制最大并发（默认 16）。
  - 响应写回：所有工作线程将序列化响应投递到单一 `mpsc` 通道，由专用写线程顺序 `writeln! + flush` 到 `stdout`，保证单行 JSON 绝对不交错。
  - 优雅退出：收到 `stdin` EOF 后置位关闭标志、停止派发新请求，等待在途工作收尾并统一树杀运行中的**后台任务**。
- **按文件路径细粒度写锁（参考 `opencode` `KeyedMutex`）**：
  - 在执行层维护进程内按归一化路径索引的锁表（Windows 大小写折叠，引用计数归零自动移除条目，避免内存泄漏）。
  - `write` 与 `edit` 在完成沙箱路径解析后获取目标文件的写锁，把「读 → 匹配/准备 → 落盘」包裹在同一临界区内；不同文件之间、读与写之间、`bash` 之间互不阻塞。

### 3. `job_output` 短等待（`wait_ms`）

- 协议层与执行层 `job_output` 请求均接受可选 `wait_ms`（缺省 `0`，超过 `30_000` 时钳制或由 schema 限制在 `0..=30_000`）。
- 协议层在调用执行器时将单次 IPC 超时预算设为 `max(基础超时, wait_ms + 安全余量)`，防止客户端误超时。
- 执行层等待逻辑（仅 `wait_ms > 0` 且任务当前处于 `running` 且请求 `offset` 处尚无新可读字节时进入等待）：
  - 任务变为 `exited` 时立刻唤醒并返回最终输出与退出码；
  - 缓冲产生新字节（相对于请求 `offset` 有可读增量）时，进入约 200ms 的短暂防抖窗口以合并同一批刷屏日志（期间若任务退出或触及总 `wait_ms` 截止时间则立刻结束防抖），随后返回增量输出；
  - 若 `stdin` 关闭（协议层断开），立刻结束等待退出。

### 4. 运行指纹、热切换结果回显与 `/api/logs` 过滤

- **运行身份指纹**：
  - 协议层启动时计算一次当前运行程序文件的 SHA-256 前 8 位作为 `buildId`（打包态取当前可执行文件，开发态取入口脚本，计算失败时安全回退为 `"unknown"`），记录启动时间 `startedAt`（ISO-8601）与 `process.pid`。
  - `GET /health` 与 `GET /api/status` 返回 `{ version, buildId, startedAt, pid }`（保持既有字段兼容，仅增量补充）。
- **热切换结果回显**：
  - **托盘宿主**（原地换核）与脱离进程树切换脚本（`deploy-local.mjs`）在每次**热切换**落定后，原子或覆盖写入运行目录 `logs/last-hotswap.json`，字段仅含脱敏摘要：`{ status: "ok" | "rolled_back" | "failed", mode: "in-place" | "detached-worker", at, detail }`（绝不写入令牌、密钥或请求头）。
  - **面板**新增 `GET /api/hotswap` 并在 `GET /api/status` 中附加 `lastHotswap` 字段，只读解析当前运行日志目录（`resolveLogDir()`）下的 `last-hotswap.json`；文件不存在或损坏时返回 `null` / `{ status: "unknown" }`，不报错影响健康接口。
- **`/api/logs` 扩容与过滤**：
  - 进程内**服务日志**环形缓冲容量从 200 行提升至 1000 行。
  - `GET /api/logs` 支持可选查询参数：`level`（`debug` | `info` | `warn` | `error`，按最低等级过滤）、`limit`（正整数，截断返回末尾 N 行；不传时默认 200 行以保持**面板**前端现状）、`q`（不区分大小写的子串匹配）。所有返回行仍经过既有脱敏逻辑。

### 5. `write` 自动创建沙箱内缺失父目录

- 词法校验仍排第一道，确保目标路径词法归一化后严格位于**沙箱根**内部且非**沙箱根**本身。
- 当目标文件不存在且直接父目录不存在时，沿祖先链向上查找最深的已存在目录，对其做 `canonicalize` 并验证其位于**沙箱根**真实路径内（含就是**沙箱根**本身）；若任一已存在祖先为指向根外的符号链接则直接以越界拒绝。
- 验证通过后创建缺失的相对子目录并落盘写入；若父路径上某一段实际是普通文件而非目录，返回清晰错误而非覆盖该文件。

## Testing Decisions

好测试只验证外部可观察行为（MCP 工具返回值、HTTP JSON 响应、文件落盘与进程并发/超时表现），不测私有辅助函数或内部锁结构。沿用仓库既有 3 个高层测试缝隙：

1. **MCP 客户端工具调用入口**（`tests/read-write.test.ts`、`tests/jobs.test.ts`、`tests/mcp.test.ts` / `tests/bash.test.ts`，拉起真实 `dist/index.js` + `nexus-executor.exe`）：验证 `write` 嵌套建目录与符号链接越界拒绝、并发 `bash` 下 `read`/`job_kill` 不阻塞、同文件并发 `edit`/`write` 无丢改动、单请求超时不误杀在跑**后台任务**、以及 `job_output(wait_ms)` 的零等待兼容/退出立返/防抖唤醒。
2. **本地 HTTP 与面板 API 入口**（`tests/http.test.ts`、`tests/observability.test.ts`、`tests/panel.test.ts`、`tests/log.test.ts`）：验证 `/health` 与 `/api/status` 的运行指纹、`/api/status` 与 `/api/hotswap` 读取 `last-hotswap.json`、以及 `/api/logs` 的 1000 行缓冲与 `level`/`limit`/`q` 组合过滤与脱敏边界。
3. **热切换与 Rust 集成入口**（`crates/tray/tests/hotswap.rs`、`tests/deploy-local.test.ts`、`crates/executor/src/main_tests.rs` & `jobs_tests.rs`）：验证托盘内换核与脱离切换器在成功与回滚两种路径下均正确写入 `last-hotswap.json`，以及执行层双车道不饿死控制命令与按文件写锁的并发边界。

（遵循仓库约定：`vitest` 固定走 `--pool=vmThreads`，断言错误 `message` 禁用 `toBeInstanceOf(Error)`，涉及子进程的用例显式设置 `>= 15_000` 超时，`cargo test` 中真实 spawn 子进程用例在模块内串行加 `SPAWN_LOCK`。）

## Out of Scope

- 不新增第 10 个 MCP 工具（不单开 `logs` / `status` / `hotswap` 工具）。
- 不为 `edit` 增加单次多段批量替换数组参数，也不改动 `glob` / `grep` 的返回上限与分页机制。
- 不引入 `tokio` 或其他重型异步运行时依赖到 `crates/executor`。
- 不修改**命令闸门**策略、`MSYS_NO_PATHCONV=1` 默认环境变量或**隧道**渠道逻辑。
- 不将跨外部进程的 OS 文件锁（`flock` / `LockFileEx`）纳入本次按文件写锁范围。

## Further Notes

- 关联决策记录：`docs/adr/0011-multiplexed-executor-ipc.md`。
- 本机参考仓 `cankaoproject/`（`codex`、`opencode`）严格只读，禁止在其中执行任何构建或修改命令。
- 完成后需按 `AGENTS.md` 跑通 `npm.cmd run check` 并可通过 `node scripts/deploy-local.mjs` 验证自举**热切换**后的新 `buildId` 与 `lastHotswap` 回显。
