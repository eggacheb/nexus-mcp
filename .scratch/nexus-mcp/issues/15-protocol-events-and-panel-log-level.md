# 15: 接入鉴权/会话/管控事件补齐与面板日志等级热切换

**What to build:** 在票 14 的**服务日志**底座上，补齐 HTTP 接入鉴权、OAuth 2.1 授权、**会话**生命周期以及**面板**/**隧道守护**管控事件的日志覆盖，并在**面板**「快捷设置」提供免重启切换 `logLevel` 的下拉入口与分级日志着色，消除「客户端重连报 404、鉴权被拒、隧道抖动却在日志里毫无痕迹」的排障盲区。

**Blocked by:** 14 (服务日志滚动落盘、四级阈值与工具调用全链路摘要)

**Status:** done

- [x] 先写失败测试再写实现，改完源码先运行 `npm run build` 再跑测试，所有验收通过公开 HTTP / MCP 客户端与**面板**接口完成
- [x] 鉴权拒绝事件可观测且严守脱敏红线：`401` / `403` 拒绝写入 `WARN` 级 `auth.deny` 事件（含状态码与原因码，如缺少凭据、令牌无效、非本机连接、代理转发头拦截、非本机 `Host` 头），严禁在 `stderr`、**面板**或磁盘日志中输出令牌原文、请求头原文或 `"authorization"`（不区分大小写）字样
- [x] OAuth 2.1 关键节点可追踪：动态客户端注册、**授权页**批准或口令错误拒绝、访问令牌签发与刷新失败分别记录对应 `INFO` / `WARN` 事件，不泄露 `client_secret`、授权码与访问/刷新令牌
- [x] **会话**全生命周期闭环：建立（记录 8 位短 `sid` 与当前活跃**会话**数）、客户端主动关闭、空闲超时回收记 `INFO`；携带未知或已失效 `Mcp-Session-Id` 触发 `404` 时记 `WARN`（含请求中携带的短 `sid`），方便定位服务重启后的连接器重连过程；`debug` 等级下额外记录 `initialize`、`tools/list` 等控制请求及 SSE 流开闭
- [x] 服务、**面板**与**隧道守护**管控事件统一为结构化等级日志：启停/重启/配置重载、切换**沙箱根**、更新快捷设置、**隧道**启停与公网可达性探测记 `INFO`（失败记 `WARN` / `ERROR`），**隧道**异常退出记 `WARN`、自动重启失败记 `ERROR`；**面板**所有只读 `GET` 接口（`/`、`/api/status`、`/api/logs`、`/api/credentials`、`/api/settings`）与 `/health` 保持零**服务日志**输出，不刷屏
- [x] **面板**「快捷设置」支持免重启热切换 `logLevel`：`GET /api/settings` 返回当前 `logLevel`，`POST /api/settings` 校验并更新内存 `config.logLevel`、同步写回 `config.json`，无需重启服务或断开现有 MCP **会话**即可立即开启 `debug` 抓现场或切回 `info`
- [x] **面板**前端日志视图兼容新格式与四级着色：保留 ISO 时间戳解析为本地 `HH:MM:SS`，按 `[ERROR]`、`[WARN]`、`[DEBUG]` 分别应用错误红、告警黄与弱化浅灰样式，关键字过滤框可按等级名（如 `debug`、`warn`）、`sid=` 或工具名直接筛选

## Comments

- 2026-11-26：按 TDD 垂直切片完成全部实现与验收，各验收项对应测试用例（`tests/observability.test.ts`）：
  1. TDD 红绿循环与公开入口验收：`tests/observability.test.ts` 全套 6 条用例（均先红后绿，通过公开 HTTP / MCP 客户端与面板接口完成）。
  2. 鉴权拒绝 `auth.deny` 与脱敏红线：`tests/observability.test.ts` > `401 / 403 鉴权拒绝写入 WARN auth.deny，且不泄露令牌原文与 authorization 字样`。
  3. OAuth 2.1 关键节点日志与零密钥泄漏：`tests/observability.test.ts` > `OAuth 2.1 动态注册、授权批准/口令拒绝、签发令牌与刷新失败均记录日志且零密钥泄漏`。
  4. 会话全生命周期、`404` 未知 `sid` 与 `debug` 控制请求/SSE：`tests/observability.test.ts` > `会话建立/关闭记 INFO、未知 sid 触发 404 记 WARN，debug 级别记录控制请求与 SSE 开闭`。
  5. 管控事件结构化日志、隧道守护异常/重启失败与只读 GET 零刷屏：`tests/observability.test.ts` > `面板所有只读 GET 与 /health 保持零服务日志输出，写操作与隧道探测产出结构化管控日志` 与 `隧道守护异常退出记 WARN、自动重启失败记 ERROR`。
  6. 面板快捷设置免重启热切换 `logLevel`：`tests/observability.test.ts` > `面板快捷设置支持免重启热切换 logLevel（不断开现有 MCP 会话），且前端支持四级着色与筛选`。
  7. 面板前端四级着色（`[ERROR]` / `[WARN]` / `[DEBUG]`）与关键字筛选：`tests/observability.test.ts` > `面板快捷设置支持免重启热切换 logLevel（不断开现有 MCP 会话），且前端支持四级着色与筛选` 及 `tests/panel.test.ts` > `页面脚本能通过语法解析`。
