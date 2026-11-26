# 01: 隧道随服务自启与协议层优雅全停入口

**What to build:** 让配置了**隧道**的**协议层**在启动就绪后默认自动拉起（或接管已有）`cloudflared`，并在**面板**新增本机回环专用的优雅全停入口，支持区分「彻底退出（同步停**隧道**且不触发**隧道守护**拉回）」与「仅停核/热切换（保持**隧道**不断）」。

**Blocked by:** None (可立即开工)

**Status:** done

- [x] 配置新增 `tunnel.autoStart`（默认 `true`），未显式关闭且**隧道**已配置时，**协议层**启动完成后自动拉起 `cloudflared`（已有外部进程在跑时按既有逻辑接管，不重复拉起）
- [x] `tunnel.autoStart: false` 时启动不自动拉起**隧道**，仍可通过**面板**手动启停
- [x] **面板**新增本机回环专用优雅关停入口（仅接受 `127.0.0.1`、校验 `Host`/`Origin` 与既有面板接口一致），支持参数区分是否一并停止**隧道**
- [x] 彻底退出路径按顺序停**隧道**（关闭**隧道守护**自动拉回）→ 停 MCP HTTP 服务 → 关闭**执行层**并**树杀**全部后台任务，退出后确认无残留 `cloudflared` 进程
- [x] 保留**隧道**的关停路径仅关闭**协议层**与**执行层**，重启新**协议层**实例后可自动重新接管运行中的**隧道**
- [x] 在 `tests/tunnel.test.ts`（缝隙 1，使用 `startServer()` + `cloudflared` stub）补齐上述全部端到端验收用例并通过 `npm run check`

## Comments

- 验收 1、3、4：`tests/tunnel.test.ts` > `隧道随服务自启与协议层优雅全停入口` > `tunnel.autoStart 默认开启：服务启动后自动拉起隧道；POST /api/shutdown(includeTunnel=true) 同步停隧道且不触发守护拉回`（验证默认自启、跨站 Origin 403、`includeTunnel: true` 停隧道与服务）。
- 验收 2、5：`tests/tunnel.test.ts` > `隧道随服务自启与协议层优雅全停入口` > `tunnel.autoStart=false 时不自启；POST /api/shutdown(includeTunnel=false) 停协议层但保留隧道存活`（验证 `autoStart: false` 不自启、手动启动后 `includeTunnel: false` 仅停协议层并保留隧道存活）。
- 已有外部进程接管：`tests/tunnel.test.ts` > `TunnelManager（进程级）` > `外部已运行的 cloudflared 被采用而不重复拉起`。
