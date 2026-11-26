# 04: 托盘内无缝换核与 10 秒健康检查自动回滚

**What to build:** 在**托盘宿主**内置仅限本机回环的受控换核通道，当 `nexus-mcp.exe` 自身未改动时，由运行中的**托盘宿主**在返回回执后延迟 1–2 秒完成停旧核（保**隧道**不断）、备份旧版为 `.prev`、替换 `nexus-server.exe` / `nexus-executor.exe`、拉起新版与 10 秒 `/health` 校验；启动失败或超时自动还原 `.prev` 回滚并落盘可读失败日志。

**Blocked by:** 02

**Status:** done

- [x] **托盘宿主**提供仅限 `127.0.0.1` 的受控换核入口，收到换核请求后先校验新产物存在，立刻返回已排队回执，延迟 1–2 秒再执行切换（不打断当前工具调用返回）
- [x] 换核流程按序执行：调用保**隧道**关停入口停旧 `nexus-server.exe` → 将运行目录旧 `nexus-server.exe` 与 `nexus-executor.exe` 备份为 `.prev` → 拷入新产物 → 拉起新 `nexus-server.exe`，全程托盘图标不退出且不中断**隧道**
- [x] 拉起新版后在 10 秒窗口内轮询 `127.0.0.1:<port>/health`，确认进程存活且返回 HTTP 200 才判定成功
- [x] 若新进程提前退出或 10 秒内未通过 `/health`，自动停止坏进程、将 `.prev` 还原覆盖并重新拉起旧版，直至旧版 `/health` 恢复 200，同时将失败原因与 stderr 尾行写入可读日志
- [x] 全程严守不触碰运行目录内的 `config.json` 与 `oauth-store.json`
- [x] 在隔离临时目录用正常 stub 与启动即崩溃 stub 编写端到端测试，分别验证正常无缝换核与 10 秒失败自动回滚，并通过全量 `npm run check`

## Comments

- 验收 1–6：`crates/tray/tests/hotswap.rs` > `in_place_hotswap_upgrades_and_bad_binary_rolls_back_preserving_user_data`（验证随机 token 鉴权 403、202 立即回执、保隧道 `includeTunnel: false` 停旧核、v1->v2 正常换核、坏产物自动还原 `.prev` 回滚并写 `logs/hotswap.log`、以及 `config.json` / `oauth-store.json` 字节级零改动）。
