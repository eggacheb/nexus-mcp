# 隧道运维：nexus.maliy.top

记录时间：2026-11-21（票 10 实施时整理）。上一轮部署的调研与实测结论在
`docs/research/tunnel-handover.md`，那篇是只读交接笔记，本文是接管后的现行运维文档。

## 当前链路（新服务）

```
Gemini 云端
  │ HTTPS + OAuth 2.1
  ▼
https://nexus.maliy.top          ← Cloudflare 命名隧道，固定域名
  ▼
cloudflared（本机进程，面板可启停）
  ▼
127.0.0.1:8787                   ← nexus-mcp（本服务，默认端口与隧道配置一致）
```

## 已有文件（本机，隧道配置一行不改）

| 路径 | 作用 |
| --- | --- |
| `C:\Program Files (x86)\cloudflared\cloudflared.exe` | cloudflared 2026.11.0（winget 安装） |
| `C:\Users\Administrator\.cloudflared\cert.pem` | 授权凭据（zone `maliy.top`） |
| `C:\Users\Administrator\.cloudflared\config.yml` | 隧道配置，`nexus.maliy.top` → `127.0.0.1:8787`，其余 host 返回 404 |
| `C:\Users\Administrator\.cloudflared\<tunnel-id>.json` | 隧道凭据（隧道 ID `a43f4b04-37f1-4be8-a7fc-2a1828b4461b`） |
| `C:\Users\Administrator\.cloudflared\start-hidden.vbs` | 隐藏窗口拉起 cloudflared（开机自启用） |
| `%APPDATA%\...\Startup\nexus-tunnel.vbs` | 启动文件夹里的副本，实现开机自启 |
| `C:\Users\Administrator\.local\bin\nexus-tunnel.cmd` | 命令行启停工具（已在本机 PATH），面板不可用时的兜底 |
| `<config.json 目录>\tunnel.log` | cloudflared 日志，面板「错误尾行」从这里取 |

## 端口占用的代价（接管前提）

**8787 同时只能有一个服务监听。** 接管前必须先停掉旧 Bridge（旧系统
`localbridge-desktop.exe`），否则新服务 `npm start` 直接绑定失败。旧系统的启动文件夹
自启项（`Nexus.lnk` → `F:\Nexus\localbridge-desktop.exe`）已于 2026-11-21 删除；
如果哪天 `F:\Nexus` 的旧系统又要跑回来，先记得它会抢 8787。

**不采用「改隧道配置指向其它端口」**：`config.yml` 是一个已经能工作的配置文件，
改它要动 Cloudflare 侧已验证的链路，而 Gemini 侧连接器记录的就是这个域名——
让新服务迁就 8787，一行配置都不用动。

## 面板操作（`http://127.0.0.1:8788`）

隧道卡提供：

- **公网地址**显示（`config.json` 的 `tunnelUrl`）；
- **启动 / 停止隧道**按钮：直接拉起/结束 cloudflared 进程，结果即时反映在状态块
  的隧道灯上；
- **检测可达性**按钮：向 `https://nexus.maliy.top/health` 发一次真实请求；
- 状态灯语义：
  - 绿「在线」= 进程在跑且公网可达；
  - 绿「运行中」= 进程在跑但没配 tunnelUrl，无法探公网（正常部署不会出现）；
  - 红「离线」= 进程没跑（附退出码）；
  - 红「异常」= 进程在跑但公网探测非 200（隧道没连上边缘、ingress 指错地方，或后面的服务挂了）；
  - 黄「不可用」= cloudflared 或 config.yml 路径失效；
  - 黄「未配置」= config.json 没有 tunnel 段 / tunnelUrl；
- 卡片下方显示 pid、退出码与 cloudflared 日志最后几行（排障用）。

对应 API：`POST /api/tunnel`，body `{"action":"start"|"stop"|"probe"}`，只接受本机
面板来源（跨站写一律 403）。

## /health 端点

新服务在 MCP 端口（8787）上提供无鉴权的 `GET /health`，返回
`{"ok":true,"service":"nexus-mcp"}`。用途：

1. 面板「检测可达性」与状态灯的公网探测目标；
2. 与旧命令行工具 `nexus-tunnel.cmd`、排障顺序里的 URL 完全一致；
3. 只暴露服务存活，无敏感信息，可以放心从公网访问。

## 开机自启（启动文件夹，已就位）

登录后由 explorer 执行 `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\nexus-tunnel.vbs`，
它调用 `C:\Users\Administrator\.cloudflared\start-hidden.vbs` 隐藏窗口拉起 cloudflared：

```vbs
Set sh = CreateObject("WScript.Shell")
sh.Run """C:\Program Files (x86)\cloudflared\cloudflared.exe"" --config ""C:\Users\Administrator\.cloudflared\config.yml"" tunnel run", 0, False
```

移除自启 = 删除 Startup 里的 `nexus-tunnel.vbs`。

**命令行工具与面板的分工**（守护带来的行为差异，别混用）：

- `nexus-tunnel status`：独立视角（tasklist + curl，不依赖服务活着），排障时先打它。
- `nexus-tunnel stop`：**只在 nexus-mcp 服务没跑时用**。服务活着时它会触发面板内置
  守护，10 秒后 cloudflared 自动复活——想真停隧道走面板「停止隧道」按钮。
- `nexus-tunnel start`：服务挂了、隧道也没了时的手动兜底拉起。
- 定位：面板跑在服务进程里，服务起不来时这套命令行是唯一入口；平时启停走面板。

**为什么不用 Windows 服务或计划任务**（上一轮两条路都实测不可用，别再走）：

1. `cloudflared service install` —— 2026.11.0 装出来的服务 binPath 只有 exe 路径、
   不带 `tunnel run`，SCM 一拉起就退出。把配置复制到 `systemprofile\.cloudflared` 也没用。
2. 计划任务 AtLogOn —— 建了 `Cloudflared-Nexus`，登录后实测不触发
   （`LastRunTime` 停在手动执行那次）。而且这个任务后来删不掉也禁用不了（系统返回「拒绝访问」）。

## 守护（自愈）方案

**已定方案：面板内置重启**（2026-11-21 拍板）。面板对它自己拉起的 cloudflared
进程做监控：异常退出 10 秒后自动拉回；面板「停止」按钮不触发重启（想停就停得住）。
`config.json` 的 `tunnel.autoRestart: false` 可关闭。

代价（如实记录，替代交接笔记原方案的代价描述）：**不加常驻进程**，但守护跟随
服务进程——nexus-mcp 服务自己挂了就没人拉隧道。这是可接受的：8787 是服务监听的，
服务死了隧道独活，Gemini 照样连不上；守护跟服务同生共死不损失实际可用性。
服务进程本身的开机自启与守护归票 11（打包）。

交接笔记里的另一方案（循环守护 vbs，代价是多一个常驻 wscript，且面板停止要引入
停止标记文件）**未采用**，原因见上；原文保留在 `docs/research/tunnel-handover.md`。

## 排障顺序（原样保留自交接笔记，下次断线照着查）

1. `nexus-tunnel status` —— 看 `Process` 行是 running 还是 NOT running
2. 进程在但 health 报 `error code: 1033` → 隧道没连上 Cloudflare 边缘，查防火墙
3. health 返回 `ok: true` 但 `nexus.connected: false` → 隧道没问题，是本机服务没起
4. Gemini 侧报连不上 → 先在浏览器打开 `https://nexus.maliy.top/health` 确认可达

注 1：第 3 条是旧系统的判定（旧 Core 的 health 带 `nexus.connected`）。新服务对应行为：
`/health` 返回 `{"ok":true}` 即隧道后的服务活着；面板状态灯直接区分「进程在跑但公网
不通」与「进程没跑」，比手查更快。

注 2（本机网络）：出网走系统代理（`HTTPS_PROXY`/`ALL_PROXY` → `127.0.0.1:7897`，
curl 默认跟随；Node 24 的 fetch 默认不跟随）。服务入口已开 `NODE_USE_ENV_PROXY`，
面板公网探测随之走代理；**代理进程挂了时面板会显示「公网不通」但隧道本身可能是好的**
——先看代理，再怀疑隧道。无代理环境的机器上该开关是空操作。

## 沙箱限制（agent 能做与不能做）

本机 agent 沙箱会拦这些操作，遇到只能让用户自己在终端执行：`schtasks`、
`cmd /c <脚本>`、`Start-Process wscript`、COM 实例化（`WScript.Shell`）、
删除 `C:\Windows\System32\Tasks\*`。

不受影响：nexus-mcp 服务进程 spawn/kill cloudflared（面板按钮就是这么实现的）、
写 `%APPDATA%` 启动文件夹、读写 `.cloudflared` 目录的配置文件。

## Gemini 实测记录（OAuth + 隧道全流程）

- [x] 已执行，成功（2026-11-21 23:07，小白操作）。

步骤：浏览器打开 Gemini → 设置 → 应用连接器 → 添加自定义 MCP，地址填
`https://nexus.maliy.top/mcp` → 跳转授权页 → 输入 `config.json` 的 token
批准 → 回到 Gemini 确认工具列表出现。

实测结果：连接器保存成功，「Nexus Mcp」显示 8 个工具
（read / write / edit / bash / glob / grep / job_start / job_output），
上次同步时间正常刷新。OAuth（动态注册 + PKCE + 隧道）全流程走通。
