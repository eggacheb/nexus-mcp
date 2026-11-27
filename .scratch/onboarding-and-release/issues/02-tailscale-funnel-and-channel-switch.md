# 02: 面板一键 Tailscale Funnel 与单通道互斥切换

**What to build:** 在协议层与面板打通 Tailscale Funnel 状态检测、一键开启/关闭（含首次 Funnel 授权链接引导与固定 `*.ts.net` 自动回填），并落牢四态公网渠道（`none` / **临时隧道** / `Tailscale Funnel` / **命名隧道**）的单通道互斥切换，确保已配好**命名隧道**且本机装有并登录 `tailscale.exe` 的用户绝不被自动接管或覆盖 `tunnelUrl`。

**Blocked by:** 01: 单通道隧道模型与临时隧道一键拉起

**Status:** done

- [x] 协议层能自动定位 `tailscale.exe`（支持环境变量覆盖供测试注入），通过 `tailscale status --json` 检测安装与登录态并读取本机固定域名（`Self.DNSName` 去掉尾随 `.`），结合 `tailscale funnel status` 判断当前是否已暴露 `<mcpPort>`。
- [x] 未安装或未登录 Tailscale 时，面板展示官方下载/登录指引与刷新按钮，绝不静默安装或自动启用。
- [x] 点击面板「一键开启 Tailscale Funnel」执行 `tailscale funnel --bg <mcpPort>`：若返回一次性授权启用链接（如 `https://login.tailscale.com/f/funnel...`），后端捕获该 URL 并由面板渲染成可点击按钮引导启用；开启成功后将 `https://<DNSName>` 持久化并更新连接信息卡与状态灯。
- [x] 点击关闭或切换至其他渠道时，执行 `tailscale funnel --https=443 off` 关闭公网暴露。
- [x] 单通道互斥切换生效：从任意活跃渠道切换到另一渠道前，协议层必先停止旧渠道（停 `cloudflared` 并暂停**隧道守护**，或关闭 Tailscale Funnel）再启动新渠道；已配好**命名隧道**的老用户即使环境里存在已登录 `tailscale`，启动时仍保持 `named` 且不覆盖其 `tunnelUrl`。
- [x] 通过面板 HTTP API 缝隙（注入 stub `tailscale` CLI 与 stub `cloudflared`）验证检测、首次授权链接捕获、一键启停、跨渠道互斥切换（旧渠道确实收到停止调用）与老用户命名隧道保护。

## Comments

- 验收清单 1、2、5、6 → `tests/tunnel.test.ts > Tailscale Funnel 与四态单通道互斥 > 老用户已配命名隧道且本机已登录 Tailscale：默认保持 named，不自动启用或覆盖 tunnelUrl`
- 验收清单 1、3、4、5、6 → `tests/tunnel.test.ts > Tailscale Funnel 与四态单通道互斥 > Tailscale Funnel 首次授权链接引导、一键开启回填，以及与临时隧道的单通道互斥切换`（20/20 通过）
