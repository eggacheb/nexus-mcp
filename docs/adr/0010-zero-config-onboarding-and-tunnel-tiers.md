# 零配置上手、单通道互斥三层隧道与本地 Release 分发

Status: accepted

面向「分享 GitHub 链接即可一键上手」的分发目标，我们决定保持安装包精简（仍只包含托盘三件套，不内嵌 `cloudflared`、Git Bash 或 Tailscale），在面板内提供三层公网接入渠道并强制**单通道互斥**：① 按需下载校验版 `cloudflared.exe` 的**临时隧道**（零账号 1 分钟体验，重启换域名）；② 一键调用本机 `tailscale` CLI 的 Tailscale Funnel（免买域名、无拦截页的永久固定 `*.ts.net` 地址）；③ 现有 Cloudflare **命名隧道**（自有域名最稳方案）。同一时刻只允许激活一种隧道渠道，切换时自动停掉旧渠道；已配置命名隧道的老用户即使本机装了 Tailscale 也不会被自动接管或覆盖 `tunnelUrl`。同时遵循 ADR-0003（不启用 GitHub Actions），通过本地 `npm run release` 脚本统一完成版本号同步、全量校验、打包、`SHA256SUMS.txt` 生成与 `gh release create`（默认 Draft）。

## Considered Options

- **安装包内置 `cloudflared.exe` 与 Git Bash**：安装包体积会从 ~30MB 暴涨至数百 MB，且引入第三方二进制的持续安全更新与二次分发负担；改为按需拉取固定校验版 `cloudflared.exe` 到用户缓存（复用 `ripgrep` 下载模式）更轻。
- **内置托管 `ngrok` 免费版作为默认固定域名方案**：虽送 1 个固定 `*.ngrok-free.app` 域名，但首次必须注册账号拿 Authtoken、有每月 1 GB / 20,000 次请求硬上限，且首次浏览器 OAuth 授权页会被反钓鱼提示拦截；不如「临时隧道（零账号体验）+ Tailscale Funnel（无请求上限、无拦截页的免费固定域名）」组合。
- **使用 GitHub Actions 自动构建发布**：与 ADR-0003 红线冲突，继续全部在本地通过 `npm run release` 构建并调用 `gh` 上传。

## Consequences

- 面板需提供显式的隧道渠道切换器（无 / 临时隧道 / Tailscale Funnel / 命名隧道），状态灯与连接信息卡统一跟随当前激活渠道。
- 托盘冷启动（含 NSIS 安装完成勾选启动）在面板就绪后自动弹出浏览器面板；开机自启快捷方式附带 `--minimized` 保持静默驻留。
- NSIS 覆盖安装/卸载前优先请求托盘控制端口优雅退出，失败再 `taskkill` 兜底；卸载时清理启动文件夹 `.lnk` 与热切换残留（`.prev`、`.tray-control.json`），仍保留 `config.json`、`oauth-store.json` 与 `workspace/`。
