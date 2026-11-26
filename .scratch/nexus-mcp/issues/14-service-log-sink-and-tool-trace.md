# 14: 服务日志滚动落盘、四级阈值与工具调用全链路摘要

**What to build:** 给**协议层**补齐结构化**服务日志**与本地滚动落盘能力。无论通过 HTTP 还是 `stdio` 启动服务并调用 9 个工具，终端 `stderr`、**面板** `/api/logs` 与本地 `.log` 文件都能看到统一单行格式的调用记录（含 ISO 时间戳、日志等级、事件名、简写**会话** id、工具名、脱敏后的目标/命令摘要、耗时毫秒数与结果或拦截原因），方便直接在**面板**查看或用 `read` / `grep` 读取本地日志文件排障；开启 `debug` 等级时还能看到工具进入瞬间与 IPC 往返耗时，快速定位卡死环节。

**Blocked by:** None (可立即开工)

**Status:** done

- [x] 先写失败测试再写实现，改完源码先运行 `npm run build` 再跑测试，所有跨组件验收从 MCP 客户端与公开 HTTP 接口进入
- [x] 目录路由与隔离符合优先级：`NEXUS_MCP_LOG_DIR` 环境变量 > 显式设置 `NEXUS_MCP_CONFIG` 时落 `<配置所在目录>/logs/`（自动隔离测试与自检进程，不污染仓库日志） > 开发态落 `nexus-mcp/.scratch/logs/` > 打包版落 `<可执行文件同目录>/logs/`；`.gitignore` 新增 `.scratch/logs/` 与 `logs/`（保持 `.scratch/nexus-mcp/` 正常受版本控制）
- [x] 文件命名与滚动清理：按 UTC 日期命名 `nexus-mcp-YYYY-MM-DD.log`（与行首 ISO 时间戳对齐），单文件满 10 MB 自动切分滚动（如 `.1.log`），启动与切分时自动清理只保留最近 10 个日志文件
- [x] 四级阈值统一控制：`config.json` 新增可选字段 `logLevel`（`debug | info | warn | error`，默认 `info`），支持 `NEXUS_MCP_LOG_LEVEL` 环境变量覆盖，非法值在 `loadConfig()` 启动或重载时直接报错拒绝；终端 `stderr`（保留 `[nexus-mcp]` 前缀）、**面板**内存环与磁盘文件共用同一阈值
- [x] 单行键值格式兼容既有读取方：行首保持 `YYYY-MM-DDTHH:mm:ss.sssZ [LEVEL] [event] ...`，兼容**面板**前端时间列切分；`stdio` 模式仅写 `stderr` 与磁盘日志文件，绝不污染 `stdout` 协议通道
- [x] 9 个工具完成调用均产出 `tool.ok`（`INFO`）或 `tool.err`（`WARN`，含业务错误与**命令闸门**拦截原因），携带短 `sid`（HTTP 取前 8 位，`stdio` 记 `stdio`）、`tool`、耗时 `ms` 与结果摘要；**后台任务** `job_output` 在 `status=running` 且本次输出为 0 字节的空轮询降级为 `DEBUG`，避免长任务轮询冲刷**面板**最近 100 行
- [x] `debug` 等级下额外记录工具进入瞬间（`tool.start`）与**协议层**到**执行层**的 IPC 往返完成元数据（`ipc.done`，含请求 `id`、`op`、耗时 `ms`；**执行层**进程崩溃或超时强杀记 `ERROR`）
- [x] 脱敏硬红线零泄漏：全局抹除 `config.token` 以及 `TOKEN=`、`PASSWORD=`、`SECRET=`、`KEY=`、`Bearer ` 形态的敏感值；`write` / `edit` 仅记录相对**沙箱根**的路径与字节数/替换长度，严禁记录 `content`、`old_string`、`new_string` 正文；`read` 仅记录相对路径、范围与行数；`glob` / `grep` 记录截断至 80 字符的 `pattern`；`bash` / `job_start` 仅记录相对 `cwd` 与压缩换行后截断至 120 字符的命令摘要，严禁记录命令输出正文

**已拍板决策：**
- **服务日志**由**协议层**直接写入自身运行态文件（与 `config.json`、`oauth-store.json` 同级），不经过**执行层**，确保执行器启动失败或崩溃时仍能落盘排障。
- 磁盘不另写 JSONL，三处统一单行键值文本。
- 等级过滤采用统一阈值（方案 A）：终端、**面板**与磁盘统一跟随当前 `logLevel`。

## Comments

- 2026-11-26：按 TDD 垂直切片完成全部实现与验收，各验收项对应测试用例（`tests/log.test.ts`）：
  1. TDD 红绿循环与端到端入口：`tests/log.test.ts` 全套 10 条用例（均先红后绿，端到端通过官方 MCP Client 与公开 HTTP/面板接口验证）。
  2. 目录路由优先级与 `.gitignore`：`tests/log.test.ts` > `目录路由严格按优先级：NEXUS_MCP_LOG_DIR > NEXUS_MCP_CONFIG 同级 logs > 开发态 .scratch/logs > 打包版 logs`；`.gitignore` 已新增 `.scratch/logs/` 与 `logs/`。
  3. UTC 命名、10 MB 滚动与保留 10 文件：`tests/log.test.ts` > `按 UTC 日期命名、统一单行格式，且四级阈值同时控制 stderr、内存环与磁盘文件` 与 `单文件达上限自动切分滚动（.1.log/.2.log），且启动与切分时只保留最近 10 个日志文件`。
  4. 四级阈值与配置校验：`tests/log.test.ts` > `未配置 logLevel 时默认 info，配置合法值时原样加载并可写回`、`NEXUS_MCP_LOG_LEVEL 覆盖 config.json 中的 logLevel`、`非法 logLevel（配置文件或环境变量）在 loadConfig 时直接报错拒绝`、`按 UTC 日期命名、统一单行格式，且四级阈值同时控制 stderr、内存环与磁盘文件`。
  5. 单行键值格式与 `stdio` 通道纯净：`tests/log.test.ts` > `stdio 模式不污染 stdout 协议通道，并在隔离目录写入 sid=stdio 的日志文件`。
  6. 9 工具 `tool.ok`/`tool.err` 与空轮询 `job_output` 降级 `DEBUG`：`tests/log.test.ts` > `HTTP 模式 9 个工具均产出 tool.ok/tool.err、严守脱敏红线，且空轮询 job_output 降级为 DEBUG`。
  7. `debug` 下 `tool.start`、`ipc.done` 与执行器崩溃 `ERROR`：`tests/log.test.ts` > `debug 等级额外记录 tool.start、ipc.done 与空轮询 job_output，执行器崩溃记 ERROR`。
  8. 脱敏硬红线零泄漏：`tests/log.test.ts` > `全局脱敏抹除 config.token 以及 TOKEN=、PASSWORD=、SECRET=、KEY=、Bearer 形态` 与 `HTTP 模式 9 个工具均产出 tool.ok/tool.err、严守脱敏红线，且空轮询 job_output 降级为 DEBUG`。
