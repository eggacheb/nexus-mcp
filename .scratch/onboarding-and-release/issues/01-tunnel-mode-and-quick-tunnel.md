# 01: 单通道隧道模型与临时隧道一键拉起

**What to build:** 引入 `tunnelMode`（`none` / `quick` / `tailscale` / `named`）单通道互斥配置模型并保持老用户既有**命名隧道**向后兼容；实现按需下载固定校验版 `cloudflared.exe` 到用户全局缓存，打通面板「一键开启/关闭**临时隧道**」、实时捕获 `https://*.trycloudflare.com` 回填连接信息卡与状态灯联动，以及**托盘宿主**安全退出时一并清理临时隧道。

**Blocked by:** None (可立即开工)

**Status:** done

- [x] `config.json` 支持 `tunnelMode`（`none` / `quick` / `tailscale` / `named`）；未显式配置时，已有 `tunnel` 段自动推导为 `named`，否则推导为 `none`，老用户零回归。
- [x] 实现按需查找与下载 `cloudflared.exe`（显式配置路径 → 系统常见位置/`PATH` → 用户缓存目录），缺失时按 pinned 版本下载并严格校验 SHA-256（走 `NODE_USE_ENV_PROXY=1`），哈希不符直接拒绝且不落盘脏文件。
- [x] 面板提供一键开启/关闭**临时隧道**入口，以无窗口模式拉起 `cloudflared tunnel --url http://127.0.0.1:<mcpPort> --no-autoupdate`，捕获 `https://*.trycloudflare.com` 并自动更新连接信息卡的 MCP 地址，同时显著提示「临时域名，重启后会变更」。
- [x] 面板与**托盘宿主**状态灯按当前 `tunnelMode` 反映健康状态：`none` 时不报红灯，`quick` 依据临时隧道存活与 URL 就绪状态亮灯，`named` 保持既有本地指标判定；切出**命名隧道**再切回时不丢失原有固定 `tunnelUrl`。
- [x] `POST /api/shutdown`（`includeTunnel=true`）退出时一并树杀/停止正在运行的**临时隧道**进程，不留孤儿进程。
- [x] 通过面板 HTTP API 缝隙（`tests/tunnel.test.ts` / `tests/panel.test.ts`，注入 stub `cloudflared` 与本地 HTTP 模拟下载服务器）验证按需下载、SHA-256 校验失败拒绝、URL 捕获回填、状态灯联动与退出清理。

## Comments

- 验收清单 1 → `tests/tunnel.test.ts > 临时隧道与单通道模式 > 未配置 tunnel 段时默认 tunnelMode=none，已有 tunnel 段时向后兼容推导为 named`
- 验收清单 2、3、5、6 → `tests/tunnel.test.ts > 临时隧道与单通道模式 > 按需下载 cloudflared：SHA-256 不符时拒绝且不留脏文件，匹配时缓存并拉起临时隧道回填连接信息`
- 验收清单 4 → `tests/tunnel.test.ts > 临时隧道与单通道模式 > 命名隧道切到临时隧道再切回命名隧道：先停旧渠道且不丢失原有固定 tunnelUrl`（18/18 通过）
