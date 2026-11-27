# nexus-mcp

给云端 AI（Gemini 自定义 MCP、ChatGPT 连接器）用的本地 MCP 服务，暴露 9 个稳定工具：
`read` / `write` / `edit` / `bash` / `glob` / `grep` / `job_start` / `job_output` / `job_kill`。

装在 Windows 上，只监听 `127.0.0.1`，通过内置托盘宿主无黑框常驻，并在浏览器控制面板内提供三层公网接入渠道（单通道互斥）。

## 快速上手（3 步连上云端 AI）

前往 **[GitHub Releases](https://github.com/eggacheb/nexus-mcp/releases)** 下载最新版本，两个包任选其一（无需安装 Node.js 或 Rust）：

- **`nexus-mcp_<版本>_x64-setup.exe`**（推荐）—— Windows 安装包。双击按当前用户安装到 `%LOCALAPPDATA%\Programs\nexus-mcp`（不弹 UAC），自带桌面与开始菜单快捷方式，卸载走「设置 → 应用」。
- **`nexus-mcp-<版本>-win64.zip`** —— 绿色便携版。解压到任意目录直接双击 `nexus-mcp.exe` 即可。

> **首次运行提示**：当前安装包未购买商业代码签名证书，Windows Defender SmartScreen 首次可能会拦截，点「**更多信息 → 仍要运行**」即可放行。发布页同时附带 `SHA256SUMS.txt` 供核对校验和。

### 第一步：安装并启动

安装完成界面默认勾选「**现在启动 nexus-mcp**」（平时也可直接双击桌面图标 `nexus-mcp`）。程序会无黑框常驻右下角系统托盘，待面板就绪后**自动在浏览器打开控制面板**（`http://127.0.0.1:8788`）。

首次启动会在程序目录自动生成 `config.json`（含随机访问令牌）与默认沙箱根目录 `workspace/`。

### 第二步：选一种公网接入渠道（单通道互斥）

在面板「**隧道**」卡选择其中一种渠道（同一时刻仅激活一种，切换时自动停掉旧渠道）：

| 渠道 | 适合场景 | 是否需买域名 | 特点 |
|---|---|---|---|
| **临时隧道**（Cloudflare Quick Tunnel） | 首次试用 / 1 分钟跑通 | 否 | 零账号、零配置；点击切换后按需下载固定校验版 `cloudflared.exe`，几秒获得 `https://*.trycloudflare.com`；**重启进程后会换域名** |
| **Tailscale Funnel** | 零域名费长期使用 | 否 | 本机装好并登录 [Tailscale](https://tailscale.com/download) 后，面板一键开启即得永久固定 `https://<机名>.<tailnet>.ts.net`（无拦截页、无请求数硬上限）；账号首次使用按面板弹出的链接点一下启用即可 |
| **Cloudflare 命名隧道** | 自有域名最稳方案 | 是 | 兼容既有 `~/.cloudflared/config.yml`，无流量/请求上限，支持 10 秒异常自动拉回；老用户已有 `tunnel` 配置时默认保持此渠道，绝不被本机 Tailscale 覆盖 |

### 第三步：填进 Gemini / ChatGPT 连接器

1. 在面板「**连接信息**」卡点「**复制地址+令牌**」。
2. **Gemini 网页版自定义 MCP**：填入 `https://<公网地址>/mcp`，自动跳到 OAuth 授权页后输入面板上的令牌批准即可。
3. **ChatGPT 连接器等支持自定义请求头的客户端**：填入相同地址，请求头带 `Authorization: Bearer <令牌>`。

> `read` / `write` / `edit` / `glob` / `grep` 开箱即用（`grep` 首次自动下载固定校验版 ripgrep 到全局缓存）；`bash` 与 `job_*` 需要本机装有 [Git for Windows](https://git-scm.com/download/win)（或在面板「快捷设置」改用 PowerShell 7 `pwsh`）。

## 9 个工具与并发能力

执行器采用**双车道多路复用 IPC**（慢 `bash` / 长等待不阻塞并发 `read`、`job_kill` 与健康检查）与**按文件写锁**（同文件并发 `write`/`edit` 串行不丢改动）：

| 工具 | 能力亮点 |
|---|---|
| `read` | 带行号分片读取（`offset` / `limit`），支持负 `offset` 尾读（如 `-50` 读最后 50 行），单行超长按 UTF-8 字符边界安全截断 |
| `write` | 整文件覆盖写入，自动创建沙箱内缺失的父目录，保留传入换行风格 |
| `edit` | 三级匹配降级（精确 → Unicode 排版归一化 → 行尾空白容错）、CRLF 双向保真；多处命中直接报出所有行号，未命中给出 `miss_hint` 附近行提示；LF 大文件零拷贝匹配 |
| `glob` | 多线程并行遍历 + `.gitignore` 感知 + 符号链接越界剪枝，按修改时间倒序返回（全根数千文件亚秒级） |
| `grep` | 基于 ripgrep，支持目录或单文件 `path`、`glob` 过滤、`ignore_case` 与 `context`（0–5 行上下文，`path:line-` 标记） |
| `bash` | 默认 Git Bash（强制 UTF-8 与 `NO_COLOR=1`），内置命令闸门与 Windows Job Object 超时整树终止 |
| `job_start` | 后台启动构建/测试/监听任务并立即返回 `job_id` 与 `pid`，进程树纳入 Windows Job Object 托管 |
| `job_output` | 按字节偏移增量读取头尾有界缓冲，支持 `wait_ms`（最长 30 秒）、`wait_for_exit`（屏蔽中途零碎输出）与 `elapsed` 耗时回报 |
| `job_kill` | 经 `TerminateJobObject` 毫秒级原子终止整棵进程树（含 detached 孙进程），已结束任务幂等返回退出码 |

## 托盘快捷操作与开机自启

- **托盘状态灯**：绿灯（正常）、黄灯（启动/连接中或仅本机模式）、红灯（面板/服务异常）。
- **右键菜单**：打开控制面板、重启服务、启停隧道、打开日志目录、勾选「**开机自启**」、安全退出（优雅停服并连同受管隧道一并关闭）。
- **静默开机自启**：勾选「开机自启」会在当前用户启动文件夹创建带 `--minimized` 参数的 `nexus-mcp.lnk`，开机静默驻留托盘不弹浏览器；平时手动双击桌面图标则会自动弹出控制面板。

## 升级与卸载

- **覆盖升级**：直接双击新版 `nexus-mcp_<版本>_x64-setup.exe` 安装即可。安装器会先通过托盘控制端口优雅退出旧托盘（保隧道不断），超时再兜底清理，不会改动 `config.json`、`oauth-store.json`、`sessions-store.json` 与 `workspace/`。
- **卸载**：走「设置 → 应用 → nexus-mcp」。卸载会优雅停服并清理程序文件、桌面/开始菜单快捷方式、开机自启 `.lnk` 与热切换残留，但**保留 `config.json`、`oauth-store.json`、`sessions-store.json` 与 `workspace/`**。

## 鉴权

`token` 非空时两条路并存：服务先比对静态 Bearer，不匹配再验 OAuth 2.1。

- **OAuth 2.1**（Gemini 走这条）：连接器填 `https://<公网地址>/mcp` 后自动发现授权端点，浏览器打开授权页输入 `config.json` 里的令牌批准即可。动态注册的客户端与 refresh token 落盘在 `config.json` 旁的 `oauth-store.json`，删掉它等于吊销所有已授权客户端。
- **静态 Bearer**：能自定义请求头的客户端都能用，令牌就是面板上显示的那个。

`token` 为空时服务不校验任何请求，仅限本机调试，别配着公网隧道用。

## 控制面板

面板独立监听 `8788`（`panelPort`，默认 `port + 1`），停服务时面板不掉线：

- **三盏状态灯**：执行器 / MCP 服务 / 隧道（命名隧道灯只读 `127.0.0.1:20241/ready` 本地信号，不靠公网往返，详见 `docs/tunnel.md`）。
- **服务控制**：停止 / 启动 / 重启 / 重载配置。
- **连接信息卡**：自动跟随当前激活隧道渠道显示 MCP 地址、令牌与 OAuth 授权入口。
- **隧道卡**：四态单通道切换（关闭 / 临时隧道 / Tailscale Funnel / 命名隧道）、一键启停与公网可达性探测。
- **根目录与快捷设置**：可视化选目录、改 `shell` / 超时 / `logLevel`（免重启热切换）/ 命令闸门，保存即写回 `config.json`；可用工具卡（9 个）与最近日志。
- **排障与可观测端点**：
  - `GET http://127.0.0.1:8787/health` / `GET http://127.0.0.1:8788/api/status`：返回运行指纹 `{ version, buildId, startedAt, pid }`；
  - `GET http://127.0.0.1:8788/api/hotswap`：返回最近一次本机热切换脱敏结果（`logs/last-hotswap.json`）；
  - `GET http://127.0.0.1:8788/api/logs?level=&limit=&q=`：过滤最近 1000 行脱敏服务日志（默认末尾 200 行）。

## 配置

优先级：**环境变量 > 程序目录的 config.json > 内置默认**。

| 环境变量 | 对应 config.json 字段 | 说明 |
|---|---|---|
| `NEXUS_MCP_CONFIG` | — | 指定配置文件位置，直接顶掉程序目录的 `config.json` |
| `NEXUS_MCP_TOKEN` | `token` | Bearer 令牌 |
| `NEXUS_MCP_ROOT` | `root` | 沙箱根目录，越界访问直接报错 |
| `NEXUS_MCP_PORT` | `port` | MCP 端口，`panelPort` 未配时取 `port + 1` |

只存在于 `config.json` 的常用字段：

| 字段 | 默认 | 说明 |
|---|---|---|
| `transport` | `http` | `stdio` 给本机客户端；打包版 `nexus-server.exe --stdio` 可无视配置强制 stdio |
| `shell` | `auto` | `bash` / `job_*` 用的 shell，默认自动找 Git Bash，可指明 `pwsh`（PowerShell 7）；`powershell`（5.1）启动即报错 |
| `commandPolicy` | 空 | 命令白/黑名单，见「命令闸门」 |
| `tunnelMode` | 自动推导 | 激活的公网渠道：`none` / `quick` / `tailscale` / `named`（省略时有 `tunnel` 段推导为 `named`，否则 `none`） |
| `tunnelUrl` | — | 命名隧道固定公网地址（切换其他渠道时不覆盖） |
| `tailscaleUrl` | — | Tailscale Funnel 固定公网地址（由面板开启时自动写入） |
| `tunnel` | — | Cloudflare 命名隧道管理段（路径 / 配置 / `autoStart` / `autoRestart` / `metricsPort`） |
| `logLevel` | `info` | 服务日志等级：`debug` / `info` / `warn` / `error`（面板支持免重启热切换，日志按日滚动且严守脱敏边界） |
| `maxOutputBytes` / `defaultTimeoutMs` | 64KB / 120s | 单工具输出上限 / 单条命令默认超时 |

字段全表与校验规则见 `src/config.ts`。

## 命令闸门

`bash` 与 `job_start` 里的每条命令在 spawn 前过闸门（`crates/executor/src/command_policy.rs`），两个工具共用同一套判定与话术。三层判定顺序固定，**任一子命令被拒则整条命令拒绝**：

1. **内置危险表**——无条件生效，开箱即拦 `rm -rf`、`format`、`diskpart`、`reg delete`、`cmd /c del /f` / `rd /s /q`、pwsh `Remove-Item -Force` 等。
2. **黑名单** `commandPolicy.deny`：通配模式，任一子命令命中即拒。
3. **白名单** `commandPolicy.allow`：通配模式，非空即启用；未命中按 `onUnmatched` 处理（默认 `deny`）。

```json
"commandPolicy": {
  "allow": ["git *", "npm run *", "cargo *"],
  "deny": ["git push --force*"],
  "onUnmatched": "deny"
}
```

闸门不绕沙箱：越出 `root` 的文件访问一律报错，不静默裁剪。

## 开发与本地分发

打包机需要 Rust 与 Node 24；目标机器什么都不用装。

```bash
npm run build         # cargo build --release（执行器 + 托盘宿主），再 tsc
npm run typecheck     # tsc 校验源码与测试类型（含未使用变量严格检查）
npm run lint:rs       # cargo clippy --all-targets -- -D warnings（零告警门禁）
npm run test          # vitest（--pool=vmThreads），跨组件验收一律走 MCP 客户端入口
npm run test:rs       # Rust 侧单测与集成测试（nexus-executor + nexus-tray）
npm run smoke         # 起服务、列出工具、调一次 read
npm run check         # build + lint:rs + test:vitest + test:rs + smoke，全绿且工作区干净时写 .git/last-check-ok
npm run package:stage # 仅产 build/package/ 最小三件套（供本机热切换）
npm run package       # 产 release/ 下的 NSIS 安装包与绿色 zip
npm run package:smoke # 在最小环境下验证打包产物（stdio + HTTP）
npm run release -- 0.2.1 --publish   # 本地一键发布：同步版本号 → check（命中 .git/last-check-ok 自动跳过，--force-check 强跑）→ 打包 → package:smoke → SHA256SUMS → gh Release（省略 --publish 为 Draft）
node scripts/deploy-local.mjs        # 本机一键热切换（保隧道不断，10 秒失败自动回滚；加 --reuse-stage 跳过重复构建与冒烟）
```

克隆后执行一次 `git config core.hooksPath scripts/hooks` 启用本地钩子：`pre-commit` 拦构建产物与测试陷阱并跑 `typecheck` + `lint:rs`；`pre-push` 跑全量 `npm run check`（工作区干净且 `HEAD` 命中 `.git/last-check-ok` 时自动跳过）。

产物落在 `release/`（不进版本库），文件名版本号取自 `package.json`：

| 文件 | 说明 |
|---|---|
| `nexus-mcp_<版本>_x64-setup.exe` | NSIS 安装包，含托盘三件套（`nexus-mcp.exe`、`nexus-server.exe`、`nexus-executor.exe`）与 `使用说明.txt` |
| `nexus-mcp-<版本>-win64.zip` | 绿色便携版，相同四文件平铺 |

目录：`src/` TypeScript 协议层、`crates/executor/` Rust 执行层、`crates/tray/` Rust 托盘宿主、`scripts/` 打包/热切换/发布、`docs/adr/` 架构决策记录。动手前读 `AGENTS.md` 与 `GLOSSARY.md`。

## 致谢

- **Nexus 项目**——本项目脱胎于它：上上游 [ysunyang4/Nexus](https://github.com/ysunyang4/Nexus)、
  上游 [shixian64/Nexus](https://github.com/shixian64/Nexus)。OAuth 桥接层自其 `apps/bridge/src/oauth.ts`
  移植而来，因此本仓库整体以 **AGPL-3.0** 发布（见 `LICENSE` 与 `NOTICE`）；工具层按「少而清楚」重写。
- **[opencode](https://github.com/anomalyco/opencode)**（MIT）——`edit` 的三级匹配、命令闸门的通配匹配、
  ripgrep 的发现与调用组合从它移植；明细见 `NOTICE` 与 `docs/research/opencode-reusable-parts.md`。
- **[codex](https://github.com/openai/codex)**（Apache-2.0）——输出有界缓冲、UTF-8 边界截断、
  命令策略的危险规则与可执行名归一化来自它；明细见 `NOTICE` 与 `docs/research/codex-reusable-parts.md`。
