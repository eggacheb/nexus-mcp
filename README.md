# nexus-mcp

给云端 AI（Gemini 自定义 MCP、ChatGPT 连接器）用的本地 MCP 服务，暴露 9 个工具：
`read` / `write` / `edit` / `bash` / `glob` / `grep` / `job_start` / `job_output` / `job_kill`。

装在 Windows 上，只监听 `127.0.0.1`，外面通过 cloudflared 隧道访问；隧道进程由自带控制面板启停和守护。

## 装上就能用

本地跑一次 `npm run package`，产物落在 `release/` 下，两个随便挑一个：

- `nexus-mcp_0.1.0_x64-setup.exe` —— 安装包。双击，装到当前用户目录（不弹 UAC），装完桌面和开始菜单有快捷方式，卸载走「设置 → 应用」。
- `nexus-mcp-0.1.0-win64.zip` —— 绿色版。解压到任意目录就能用。

**三步上手：**

1. 双击桌面上的 `nexus-mcp`（或解压目录里的 `启动.cmd`），控制面板会在浏览器里打开。
2. 面板「连接信息」里直接显示云端要填的 MCP 地址和令牌，点「复制地址+令牌」一次带走
   （首次启动自动生成，同时打印在启动窗口里）。
3. 云端填地址：Gemini 会跳到 OAuth 授权页，输入面板上的令牌批准即可；
   ChatGPT 连接器等能自定义请求头的客户端用 Bearer 鉴权（`Authorization: Bearer <令牌>`）。
   两条路并存，详见下面「鉴权」。

首次启动会在程序目录生成 `config.json` 和 `workspace/`（默认沙箱根）。卸载不会删这两个。

`bash` 与 `job_*` 需要机器上有 Git Bash（Git for Windows）；`read` / `write` / `edit` / `glob` / `grep`
不依赖任何外部命令。`grep` 首次使用会下载一份固定版本的 ripgrep 到全局缓存。

## 鉴权

`token` 非空时两条路都开着：服务先比对静态 Bearer，不匹配再验 OAuth 2.1。

- **OAuth 2.1**（Gemini 走这条）：连接器填 `https://<隧道域名>/mcp` 后自动发现授权端点，
  浏览器打开授权页，输入 `config.json` 里的令牌批准即可。动态注册的客户端与
  refresh token 落盘在 `config.json` 旁的 `oauth-store.json`，删掉它等于吊销所有已授权客户端。
- **静态 Bearer**：能自定义请求头的客户端都能用，令牌就是面板上显示的那个。

`token` 为空时服务不校验任何请求，仅限本机调试，别配着隧道用。

## 控制面板

面板独立监听 `8788`（`panelPort`，默认 `port + 1`），停服务时面板不掉线：

- 三盏状态灯：执行器 / MCP 服务 / 隧道。隧道灯只看 cloudflared 的本地就绪连接数，
  不看公网往返（为什么，见 `docs/tunnel.md`）。
- 服务按钮：停止 / 启动 / 重启 / 重载配置。
- 连接信息卡：MCP 地址、令牌显示与复制，外加 OAuth 授权入口。
- 隧道卡（配了 `tunnel` 段才有）：公网地址、启动 / 停止隧道、检测可达性
  （真实请求公网 `/health`，只影响这条显示，不影响灯）、pid 与日志尾行。
- 根目录选择，保存即生效；可用工具卡（9 个）；最近 100 行日志。

## 隧道

- 服务在 MCP 端口上提供无鉴权的 `GET /health`，只报存活，可从公网访问。
- 配置 `tunnel` 段后面板接管 cloudflared：进程异常退出 10 秒后自动拉回
  （`tunnel.autoRestart: false` 关闭）；面板「停止隧道」不触发守护，想停就停得住。
- 命令行兜底 `nexus-tunnel.cmd`：服务挂死时用它手动拉起；服务活着时 `nexus-tunnel stop`
  会被守护 10 秒拉回，真停隧道走面板按钮。现行运维记录都在 `docs/tunnel.md`。

## 开机自启（可选）

安装包和绿色版**都不会**加开机自启。要的话，在
`%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup` 放一个 `nexus-mcp.vbs`：

```vbs
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = "C:\Users\<你>\AppData\Local\Programs\nexus-mcp"
sh.Run """C:\Users\<你>\AppData\Local\Programs\nexus-mcp\nexus-mcp.exe""", 0, False
```

结尾的 `0` 是隐藏窗口，`False` 是不等它退出。

cloudflared 另有自己的一份开机自启（启动文件夹里的 `nexus-tunnel.vbs`），跟这份脚本互不相干。
隧道守护跟随服务进程——服务没起时，隧道靠它自己的自启活着。现状见 `docs/tunnel.md`。

**卸载程序不会删这个文件**（它只认自己装的东西）。卸载后记得手动删掉，否则每次开机都会弹一次找不到 exe 的报错。

## 升级 / 换版本

1. 先确认 8787 上没人监听：`Get-NetTCPConnection -LocalPort 8787 -State Listen`。
   有输出说明还有旧进程，用 `OwningProcess` 那一列的 pid 结束它：`Stop-Process -Id <pid>`。
2. 双击新的安装包装上。覆盖安装会自己 `taskkill` 掉 `nexus-mcp.exe` 和 `nexus-executor.exe`，
   但**杀不掉开发态起的 `node dist/index.js`**——端口冲突就是这么来的。
3. 重新启动服务。

装完启动报 `EADDRINUSE: address already in use 127.0.0.1:8787`，就是第 1 步没清干净。

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
| `transport` | `http` | `stdio` 给本机客户端；打包版 exe 加 `--stdio` 参数可无视配置强制 stdio |
| `shell` | `auto` | `bash` / `job_*` 用的 shell，默认自动找 Git Bash，可指明 `pwsh`（PowerShell 7）；`powershell`（5.1）启动即报错 |
| `commandPolicy` | 空 | 命令白/黑名单，见「命令闸门」 |
| `tunnelUrl` | — | 隧道公网地址，配了面板才会去探测连通性 |
| `tunnel` | — | cloudflared 管理段（路径 / 守护开关 / metrics 端口），配了面板才提供隧道启停 |
| `maxOutputBytes` / `defaultTimeoutMs` | 64KB / 120s | 单工具输出上限 / 单条命令默认超时 |

字段全表与校验规则见 `src/config.ts`。

## 命令闸门

`bash` 与 `job_start` 里的每条命令在 spawn 前过闸门（`crates/executor/src/command_policy.rs`），
两个工具共用同一套判定与话术。三层判定顺序固定，**任一子命令被拒则整条命令拒绝**：

1. **内置危险表**——无条件生效，不依赖用户配置，开箱即拦：
   - `rm` 同时带递归（`-r`/`-R`/`--recursive`）与强制（`-f`/`--force`）标记（仅 git-bash）；
   - `format`、`diskpart`、`reg delete`；
   - `cmd /c` 内部的 `del`/`erase` 带 `/f`、`rd`/`rmdir` 带 `/s /q`（黏连运算符如 `echo hi&del` 会切开判定）；
   - pwsh 下删除 cmdlet（`Remove-Item` 及别名 `rm`/`ri`/`del`/`erase`/`rd`/`rmdir`）与 `-Force` 同段出现；
     显式 `pwsh -Command "..."` 包裹时，任何 shell 下都检查脚本内容。

   拒绝话术附命中规则、原因与替代做法，可直接贴给模型。
2. **黑名单** `commandPolicy.deny`：通配模式，任一子命令命中即拒。
3. **白名单** `commandPolicy.allow`：通配模式，非空即启用；每条子命令都必须命中，
   没接住的按 `onUnmatched` 处理（默认 `deny`，改 `"allow"` 可放宽）。

```json
"commandPolicy": {
  "allow": ["git *", "npm run *", "cargo *"],
  "deny": ["git push --force*"],
  "onUnmatched": "deny"
}
```

判定前的解析规则：

- 顶层 `;` `&&` `||` `|` `&` 把命令拆成简单命令段，逐段判定；
- `$( )`、反引号、进程替换、双引号内的替换体递归检查一层；`sudo`/`env` 前导与 `VAR=value`
  赋值剥离后再判；`trap` 的 action 当 shell 源码递归；
- **fail-closed**：引号/括号/反引号未闭合、命令名含变量或替换（首词带 `$`）、wrapper 嵌套
  超过 8 层，一律拒绝，不猜。

匹配细节：白/黑名单的匹配目标是「归一化后的可执行名 + 其余参数原样」——首词剥路径与盘符、
ASCII 小写、去掉 `.exe`/`.cmd`/`.bat`/`.com` 后缀。模式里 `*` 匹配任意序列（含空格）、
`?` 匹配单字符，`\` 与 `/` 等价，Windows 下大小写不敏感；模式以 `" *"` 结尾时裸命令
（不带参数）也命中。

已知局限（字面判定哲学）：只看命令字面量，看不见变量展开后的实际内容（动态命令名因此直接
fail-closed）；管道把数据喂给危险命令（如 `cat list | xargs rm`）这类数据流不在字面判定范围内。

闸门不绕沙箱：越出 `root` 的文件访问一律报错，不静默裁剪。

## 分发

打包机需要 Rust 与 Node 24；目标机器什么都不用装。

```bash
npm run package        # 约 25 秒：esbuild 打 CJS → SEA 注入 → zip → NSIS 安装包
npm run package:smoke  # 拿刚出的产物在最小环境里自检：启动、连上、read、面板
```

产物落在 `release/`（不进版本库），文件名里的版本号取自 `package.json`：

| 文件 | 说明 |
|---|---|
| `nexus-mcp_<版本>_x64-setup.exe` | NSIS 安装包，按用户装到 `%LOCALAPPDATA%\Programs\nexus-mcp`，桌面 + 开始菜单快捷方式，卸载入口进「应用和功能」 |
| `nexus-mcp-<版本>-win64.zip` | 绿色版，四个文件平铺：`nexus-mcp.exe`、`nexus-executor.exe`、`启动.cmd`、`使用说明.txt` |

发给别人之前要知道的：

1. 都没有签名，SmartScreen 首次会拦一次（「更多信息 → 仍要运行」），企业策略可能直接拦掉。要正经发就得买代码签名证书。
2. 两个 exe 必须在同一目录：`nexus-mcp.exe` 找不到 `nexus-executor.exe` 时，只有文件类工具能用，报错里会指出缺哪个文件。
3. 覆盖安装会先 `taskkill` 掉正在跑的 `nexus-mcp.exe` / `nexus-executor.exe`（杀不掉开发态的 `node dist/index.js`，见「升级 / 换版本」）；卸载只删程序文件，`config.json`、`workspace` 和你自己加的开机自启脚本都留着。
4. 第一次打包要联网取 NSIS 3.11（2.4MB，脚本里钉了 SHA-256 校验）；内网机器可以用 `NEXUS_NSIS_DIR` 指向已解压的 NSIS 目录跳过下载。
5. 默认 MCP 端口 8787、面板 8788；目标机器上被占了就改 `config.json` 的 `port` / `panelPort`。

## 开发

```bash
npm run build        # cargo build --release 构建执行器，再 tsc
npm run typecheck
npm run test         # vitest，只走 MCP 客户端入口
npm run test:rs      # Rust 侧
npm run smoke        # 起服务、列出工具、调一次 read
npm run check        # build + vitest + cargo test + smoke，提交前必须全绿
npm run package      # 出 release/ 下的 zip 与 NSIS 安装包
npm run package:smoke # 在最小环境下验证打包产物（启动、连上、read、面板）
```

目录：`src/` TypeScript 侧（MCP 协议、工具、HTTP、面板、执行器客户端）、`crates/executor/` Rust 执行器、
`scripts/` 自检与打包、`docs/research/` 调研笔记。

动手前读 `AGENTS.md`（命令、禁忌、踩过的坑），调研结论在 `docs/research/`。

## 致谢

- **Nexus 项目**——本项目脱胎于它：上上游 [ysunyang4/Nexus](https://github.com/ysunyang4/Nexus)、
  上游 [shixian64/Nexus](https://github.com/shixian64/Nexus)。OAuth 桥接层自其 `apps/bridge/src/oauth.ts`
  移植而来，因此本仓库整体以 **AGPL-3.0** 发布（见 `LICENSE` 与 `NOTICE`）；工具层按「少而清楚」重写。
- **[opencode](https://github.com/anomalyco/opencode)**（MIT）——`edit` 的三级匹配、命令闸门的通配匹配、
  ripgrep 的发现与调用组合从它移植；明细见 `NOTICE` 与 `docs/research/opencode-reusable-parts.md`。
- **[codex](https://github.com/openai/codex)**（Apache-2.0）——输出有界缓冲、UTF-8 边界截断、
  命令策略的危险规则与可执行名归一化来自它；明细见 `NOTICE` 与 `docs/research/codex-reusable-parts.md`。
