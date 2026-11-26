# 06: 本地一键热切换部署脚本与托盘自身更新验收

**What to build:** 提供一条不依赖 pnpm POSIX `npm` wrapper 的统一本地部署脚本，串联「快速最小三件套构建 → 新产物临时端口 smoke → 按 `nexus-mcp.exe` 哈希分流执行延迟**热切换**」，同时覆盖托盘自身变更时的脱离进程树切换与失败回滚，并更新 `AGENTS.md` 中的自举开发指引。

**Blocked by:** 04, 05

**Status:** done

- [x] 新增统一本地部署脚本（可用 `node scripts/deploy-local.mjs` 直接运行，保留**执行层**的 `MSYS_NO_PATHCONV=1` 且不踩 pnpm `npm` wrapper 路径坑），目标运行目录默认 `C:\Users\Administrator\AppData\Local\Programs\nexus-mcp\` 并支持环境变量覆盖
- [x] 部署前串行执行最小三件套构建与新产物临时端口 smoke（验证 `/health` 200 与至少一次工具调用），任一步失败直接中止且不触碰运行目录
- [x] 对比新旧 `nexus-mcp.exe` 哈希：未变时调用 04 的托盘内无缝换核通道；发生变化时拉起脱离当前进程树的临时切换器，延迟 1–2 秒后停旧**托盘宿主**与 `nexus-server.exe`（保**隧道**不断）、备份 `.prev`、替换三件套并拉起新 `nexus-mcp.exe`，同样执行 10 秒 `/health` 校验与失败自动回滚
- [x] 切换全程保证运行目录内的 `config.json` 与 `oauth-store.json` 字节级不变，当前调用立刻返回已排队回执与切换日志路径
- [x] 补齐缝隙 3 端到端集成测试（在隔离临时运行目录验证：正常换核、坏产物 10 秒回滚、托盘自身哈希变更切换三路径）
- [x] 更新 `AGENTS.md` 中的本机自举开发与**热切换**命令约定，并通过全量 `npm run check`

## Comments

- 验收 1–5：`scripts/deploy-local.mjs` + `tests/deploy-local.test.ts` > `票 06: 本地一键热切换部署脚本（缝隙 3）` > `独立运行目录：首次脱离进程树部署 -> 同哈希走托盘内换核 -> 坏托盘包触发 10 秒内自动回滚，config/oauth 零改动`（全绿）。
- 验收 6：`AGENTS.md` 已补充 `npm run package:stage` 与 `node scripts/deploy-local.mjs` 约定。
