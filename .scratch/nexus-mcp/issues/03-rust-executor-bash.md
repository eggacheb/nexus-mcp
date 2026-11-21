# 03: Rust 执行器骨架与 `bash`

**What to build:** 新增一个 Rust 可执行程序作为唯一的执行层，被协议层通过 stdio 调用。`bash` 工具第一次真正跑起命令：拿到合并后的输出和退出码，中文不乱码，跑太久会被杀掉，输出太长会截断并标注省略。

**Blocked by:** None（可以立即开始，与 01 并行）

**Status:** done

- [x] 新增 Rust 可执行程序，通过单行 JSON 的 stdio 协议响应请求，请求带自增 id
- [x] 协议层不再直接创建子进程，所有命令执行都经由执行层
- [x] `bash` 在给定工作目录执行命令，返回合并的标准输出与错误输出，以及退出码
- [x] 退出码非零时工具结果仍是正常返回（由模型判断），不标记为协议错误
- [x] 默认使用 Git Bash，启动时设置 `LANG=zh_CN.UTF-8`、`LC_ALL=C.UTF-8`、`MSYS_NO_PATHCONV=1`
- [x] 配置为 PowerShell 时只允许 PowerShell 7，显式指定 5.1 时启动即报错并说明原因
- [x] 输出含中文时两端解码正确，不乱码
- [x] 超过 `timeout_ms` 的子进程被终止，返回明确的超时信息而不是挂起
- [x] 输出超过上限时保留头部与尾部，中间标注省略的字节数
- [x] 执行器进程意外退出时，协议层返回可读错误而不是卡死等待

**复用来源：** 输出有界缓冲直接搬 codex 的 `utils/head-tail-buffer`（零依赖，纯 std，拷文件即可）；UTF-8 安全截断搬 `utils/string` 的 `take_bytes_at_char_boundary`。两者都在 `D:\code\Nexus\cankaoproject\codex\codex-rs` 下，对应说明见 `docs/research/codex-reusable-parts.md` §2.9 与 §5。不要自己写环形缓冲。

## Comments

- 落地为 `crates/`（workspace，target 统一在 `crates/target/`）+ `crates/executor`（bin `nexus-executor`，依赖仅 serde/serde_json）与 `src/executor.ts` 协议客户端（自增 id、串行请求、退出即 failAll、请求级看门狗兜底）。
- 超时与退出码非零都走正常返回：`exit_code: N` / `timed_out: Nms（命令已终止）`；协议与执行器故障才标 isError。
- 决策（经确认）：超时=正常返回加超时信息；`shell: auto` 解析不到 Git Bash 时启动即报错，不回退 pwsh。
- HeadTailBuffer 按票要求搬运，做了两处必要适配：const 泛型预算改为运行时值（预算来自 `maxOutputBytes` 配置），新增 head/tail 访问器供渲染时做 UTF-8 边界修整；`NOTICE` 与文件头已注明来源与改动。
- 测试注入口：`NEXUS_MCP_EXECUTOR`（注入假执行器测崩溃路径，配 `crates/executor/src/bin/crash-helper.rs`）、`NEXUS_GIT_BASH`（测缺 Git Bash 启动报错）。构建接线：`npm run build:executor`，check 顺序为 build + vitest + cargo test + smoke。
- 补充（票外）：pwsh 7 路径补了端到端用例；`shell 配置校验` 两条用例因服务拒绝启动、无法走 MCP 客户端，直接收集启动进程 stderr，属变通。
- 后续修复：面板执行器状态灯按注释承诺换成真握手——执行器新增 `ping` op，`probeExecutorHandshake` 临时起进程发 ping（2 秒超时），`executorStatus` 改异步，面板轮询时不再显示「未接入」。
