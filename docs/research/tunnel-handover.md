# 交接笔记：cloudflared 隧道

记录时间：2026-11-21。来自上一轮部署的实测结论，原样保留，票 10 实施时按这里来。

## 当前链路（旧系统，端口要换成本项目的）

```
Gemini 云端
  │ HTTPS + OAuth 2.1
  ▼
https://nexus.maliy.top          ← Cloudflare 命名隧道，固定域名
  ▼
cloudflared（本机常驻进程）
  ▼
127.0.0.1:8787                   ← 旧：Nexus MCP Bridge（新项目默认为 8790）
  ▼
127.0.0.1:18080（旧 Core）→ Runner → 项目目录
```

Gemini 的「自定义 MCP 应用」只接受 `https://` 公网地址，隧道断了连接器立刻失效。

## 已有文件

| 路径 | 作用 |
| --- | --- |
| `C:\Program Files (x86)\cloudflared\cloudflared.exe` | cloudflared 2026.11.0（winget 安装） |
| `C:\Users\Administrator\.cloudflared\cert.pem` | 授权凭据（zone `maliy.top`） |
| `C:\Users\Administrator\.cloudflared\config.yml` | 隧道配置，`nexus.maliy.top` → `127.0.0.1:8787`，其余 host 返回 404 |
| `C:\Users\Administrator\.cloudflared\<tunnel-id>.json` | 隧道凭据（隧道 ID `a43f4b04-37f1-4be8-a7fc-2a1828b4461b`） |
| `C:\Users\Administrator\.cloudflared\start-hidden.vbs` | 隐藏窗口拉起 cloudflared |
| `%APPDATA%\...\Startup\nexus-tunnel.vbs` | 启动文件夹里的副本，实现开机自启 |
| `C:\Users\Administrator\.local\bin\nexus-tunnel.cmd` | 命令行工具，已在本机 PATH 里 |

## 日常操作

```
nexus-tunnel          没跑就拉起，在跑只报状态
nexus-tunnel status   只看状态
nexus-tunnel stop     停掉（taskkill cloudflared.exe）
```

脚本只用 `tasklist`、`wscript`、`curl`，不依赖 `schtasks`。

## 为什么不用 Windows 服务或计划任务

两条路都试过，都不可用，别再走：

1. `cloudflared service install` —— 2026.11.0 装出来的服务 binPath 只有 exe 路径、不带 `tunnel run`，SCM 一拉起就退出。把配置复制到 `systemprofile\.cloudflared` 也没用。
2. 计划任务 AtLogOn —— 建了 `Cloudflared-Nexus`，登录后实测不触发（`LastRunTime` 停在手动执行那次）。而且这个任务后来删不掉也禁用不了（系统返回「拒绝访问」）。

启动文件夹里的 `.vbs` 是最省事可靠的一条：登录后由 explorer 执行，隐藏窗口，不弹黑框。

## 已知弱点

- **没有自愈**：cloudflared 退出后不会自动重启，需要手动跑 `nexus-tunnel`。睡眠唤醒、网络切换后可能掉线。
- **登录才启动**：注销后不跑；锁屏不影响。
- **尚未经过重启验证**：改成启动文件夹后机器还没重启过。
- **旧计划任务残留**：`Cloudflared-Nexus` 还在，需要管理员 PowerShell 执行 `schtasks /Delete /TN "Cloudflared-Nexus" /F` 清掉。不清不影响功能。

## 可选加固：循环守护

改 `start-hidden.vbs` 为循环，进程退出 10 秒后自动重启：

```vbs
Set sh = CreateObject("WScript.Shell")
cmd = """C:\Program Files (x86)\cloudflared\cloudflared.exe"" --config ""C:\Users\Administrator\.cloudflared\config.yml"" tunnel run"
Do
  sh.Run cmd, 0, True
  WScript.Sleep 10000
Loop
```

代价是多一个常驻 wscript 进程。改之前问用户。

## 排障顺序

1. `nexus-tunnel status` —— 看 `Process` 行是 running 还是 NOT running
2. 进程在但 health 报 `error code: 1033` → 隧道没连上 Cloudflare 边缘，查防火墙
3. health 返回 `ok: true` 但 `nexus.connected: false` → 隧道没问题，是本机服务没起
4. Gemini 侧报连不上 → 先在浏览器打开 `https://nexus.maliy.top/health` 确认可达

## 环境限制

本机 agent 沙箱会拦这些操作，遇到只能让用户自己在终端执行：`schtasks`、`cmd /c <脚本>`、`Start-Process wscript`、COM 实例化（`WScript.Shell`）、删除 `C:\Windows\System32\Tasks\*`。
