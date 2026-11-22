# nexus-mcp

给云端 AI 用的单目录沙箱本地 MCP 服务：9 个稳定工具、命令闸门、控制面板与 cloudflared 隧道。

## Language

### 架构

**协议层**:
TypeScript 侧（`src/`），负责 MCP 协议、传输、鉴权、面板与配置；自身不执行任何文件或进程操作。
_Avoid_: 桥接层、网关、服务壳

**执行层**:
Rust 侧（`crates/executor/`），唯一接触真实磁盘与进程的部分，经 stdio 单行 JSON 被协议层调用。
_Avoid_: 底层、引擎（「执行器」保留给 exe 文件名 `nexus-executor`）

**沙箱根**:
配置 `root` 指定的唯一允许访问目录；所有 `path` 相对它解析，越界一律拒绝、不静默裁剪。
_Avoid_: 工作目录、项目目录（`workspace/` 只是沙箱根的默认目录名）

**面板**:
协议层同进程提供的本地网页，看状态、管服务与隧道。
_Avoid_: 控制台、dashboard、桌面应用（本服务刻意不做桌面原生应用）

### 命令策略

**命令闸门**:
`bash` 与 `job_start` 的命令在 spawn 之前过的策略检查；拒绝时返回带命中规则与替代方案的可读话术。
_Avoid_: 命令过滤、安全审查、沙箱（沙箱专指路径边界）

**内置危险表**:
闸门里不依赖用户配置、无条件生效的拒绝规则，优先级高于白/黑名单。
_Avoid_: 默认黑名单、内置黑名单（「黑名单」专指用户配的 deny）

**白名单 / 黑名单**:
`commandPolicy.allow` / `commandPolicy.deny`，通配模式；allow 非空即启用白名单语义，未命中的按 `onUnmatched` 处理。
_Avoid_: 许可列表、禁用列表

### 后台任务

**后台任务**:
`job_start` 启动、`job_id` 标识的长任务；`job_output` 增量读输出，`job_kill` 终止。
_Avoid_: 异步任务、作业

**树杀**:
按进程树整棵终止，Windows Job Object 兜底；服务关停与 `job_kill` 都走它。
_Avoid_: 强杀、kill -9

### 接入

**连接器**:
云端 AI（Gemini 网页版自定义 MCP、ChatGPT 连接器）里保存本服务的那条配置。
_Avoid_: 客户端（本地测试客户端也是客户端；连接器专指云端那条）

**会话**:
按 `Mcp-Session-Id` 隔离的一个独立 server 实例；会话关闭时释放其后台任务引用。
_Avoid_: 连接、对话

**授权页**:
OAuth 2.1 流程中要求输入本地令牌才批准的浏览器页面。
_Avoid_: 登录页、同意页

**隧道**:
cloudflared 命名隧道，把 `127.0.0.1:8787` 映射成固定 https 域名。
_Avoid_: 内网穿透、frp

**隧道守护**:
面板对自家拉起的 cloudflared 的看护：异常退出 10 秒拉回；面板「停止」不触发守护。
_Avoid_: 自愈、supervisor

**状态灯**:
面板顶部指示执行器、MCP 服务、隧道健康的三盏灯；隧道灯只读本地信号，不看公网往返。
_Avoid_: 红绿灯、指示器
