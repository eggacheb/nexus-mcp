# 04: 运行指纹、热切换结果回显与 `/api/logs` 过滤增强

**What to build:** 补齐自举调试与**热切换**后的本地可观测性：在 `/health` 与 `/api/status` 暴露当前运行内核的构建指纹，在**热切换**落定后将脱敏结果写盘并经 `/api/status` 与 `/api/hotswap` 回显，并将进程内**服务日志**环扩至 1000 行且支持 `/api/logs` 按条件过滤。

**Blocked by:** None (可立即开工)

**Status:** done

- [x] `GET /health` 与 `GET /api/status` 在保持既有字段兼容的基础上新增运行身份信息 `{ version, buildId, startedAt, pid }`，其中 `buildId` 为协议层启动时对当前程序文件计算的短 SHA-256（前 8 位，异常时安全回退 `"unknown"`）。
- [x] **托盘宿主**（`crates/tray/src/hotswap.rs`）与脱离进程树切换器（`scripts/deploy-local.mjs`）在每次**热切换**成功、回滚或失败后，向运行目录 `logs/last-hotswap.json` 写入脱敏结构化摘要 `{ status, mode, at, detail }`（绝不记录令牌、密钥或敏感头）。
- [x] **面板**新增 `GET /api/hotswap` 并在 `GET /api/status` 附带 `lastHotswap` 字段，只读返回当前日志目录下的 `last-hotswap.json`；文件缺失或损坏时返回兜底空态，不影响服务健康接口。
- [x] 进程内**服务日志**环形缓冲容量从 200 行扩大到 1000 行；`GET /api/logs` 新增可选查询参数 `level`（最低级别）、`limit`（返回末尾 N 行，缺省保持 200 行兼容面板前端）、`q`（不区分大小写子串过滤），返回内容严格维持脱敏与禁用 `"Authorization"` 边界。
- [x] 通过 HTTP/观测/日志测试（`tests/http.test.ts`、`tests/observability.test.ts`、`tests/log.test.ts`、`tests/panel.test.ts`）、部署脚本测试（`tests/deploy-local.test.ts`）与 Rust 托盘热切换测试（`crates/tray/tests/hotswap.rs`）全链路验收。

## Comments

- 验收清单 1、3 → `tests/observability.test.ts > 票 15.2 & 15.3：管控事件日志、只读接口零刷屏、面板 logLevel 热切换与四级着色 > 运行指纹、热切换结果回显（/api/hotswap & /api/status）与 /api/logs 过滤增强`
- 验收清单 2 → `crates/tray/tests/hotswap.rs > in_place_hotswap_upgrades_and_bad_binary_rolls_back_preserving_user_data`（校验成功 `ok` 与回滚 `rolled_back` 均写入 `logs/last-hotswap.json`）及 `tests/deploy-local.test.ts`
- 验收清单 4、5 → `tests/log.test.ts > 端到端服务日志与工具调用全链路摘要 > 内存服务日志环容量扩大至 1000 行，queryLogs 支持 level/limit/q 过滤且默认 200 行`、`tests/observability.test.ts`、`tests/log.test.ts`（11/11 通过）与全量 `npm.cmd run check`
