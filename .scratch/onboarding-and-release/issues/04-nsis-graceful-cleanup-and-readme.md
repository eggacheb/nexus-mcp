# 04: NSIS 优雅退出、卸载清理与用户向文档改写

**What to build:** 收尾 NSIS 安装/卸载生命周期（覆盖升级与卸载优先经**托盘宿主**控制端口优雅退出，卸载时清理开机自启 `.lnk` 与**热切换**残留且严格保留用户数据），并将 `README.md` 与打包内 `使用说明.txt` 全面更新为面向普通用户的「下载 → 双击 → 3 步连上」引导。

**Blocked by:** 02: 面板一键 Tailscale Funnel 与单通道互斥切换, 03: 托盘宿主冷启动自动弹面板与 `--minimized` 开机静默

**Status:** done

- [x] `scripts/installer/nexus-mcp.nsi` 在覆盖安装与卸载前，优先读取安装目录 `.tray-control.json` 向 `127.0.0.1:<port>/quit` 带 `X-Tray-Token` 发优雅退出请求并短暂等待；控制文件缺失或超时未退再回退 `taskkill /F`。
- [x] NSIS 卸载段额外清理启动文件夹中的 `nexus-mcp.lnk`、安装目录下的 `.tray-control.json`、`nexus-mcp.exe.prev`、`nexus-server.exe.prev`、`nexus-executor.exe.prev` 与 `nexus-mcp.exe.old`；严格保留 `config.json`、`oauth-store.json`、`sessions-store.json` 与 `workspace/`。
- [x] 重写 `README.md` 顶部为面向收到 GitHub 链接用户的三步上手：Releases 下载直达链接、Windows SmartScreen 首次放行说明、安装完成自动弹面板、三层公网接入渠道对比（1 分钟**临时隧道** / 免域名 Tailscale Funnel / 自有域名**命名隧道**）；彻底清除过时的 `启动.cmd`、手动 `nexus-mcp.vbs`、双 exe 描述与手杀 8787 步骤，将开发与构建命令移至后半段。
- [x] 同步更新 `scripts/package.ts` 中生成的 `使用说明.txt`，与托盘自动弹面板及三层隧道体验保持一致。
- [x] 更新并通过 `tests/packaging.test.ts`（断言 NSIS 优雅退出、残留清理与用户数据保留边界）及 `npm run package:stage` + `npm run package:smoke`。

## Comments

- 验收清单 1–5 → `tests/packaging.test.ts > 打包与配置优先级 > NSIS 脚本覆盖安装与卸载优先优雅退出托盘、清理残留并保留用户数据，且 README 已切向用户三步上手`（12/12 通过；整体验收阶段再跑 `package:stage` + `package:smoke` 端到端验证）
