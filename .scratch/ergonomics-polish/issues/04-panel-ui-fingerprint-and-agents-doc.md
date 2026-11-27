# 04: 面板 UI 展示运行指纹与热切换状态 + 同步更新 `AGENTS.md`

**What to build:** 在**面板**页头与状态区展示 `buildId` 和最近一次**热切换**结果（若有），同时更新 `AGENTS.md` 反映最新工具能力与排障接口。

**Blocked by:** 01, 02 (等待 `grep` 与 `read` 新能力落地后一次性同步 `AGENTS.md`)

**Status:** done

- [x] **面板**页头在版本号旁显示运行指纹 `buildId`（如 `v0.2.0 · e3d3aec0`），并在收到 `lastHotswap` 时显示简洁的最近一次**热切换**状态提示（不展示敏感信息）。
- [x] **面板**内联脚本继续通过 `tests/panel.test.ts` 的 `new Function` 语法校验，且页头与状态接口同源。
- [x] `AGENTS.md` 同步更新 `write` 自动建目录、`job_output.wait_ms`、`grep` 单文件搜索、`read` 负偏移尾读以及 `/health` / `/api/hotswap` / `/api/logs` 过滤参数。
- [x] 通过 `tests/panel.test.ts` 与全量 `npm.cmd run check` 验收。

## Comments

- 验收清单 1–4 → `tests/panel.test.ts > 本地控制面板 > 页面脚本能通过语法解析`、`版本号可见：页头直接印出，状态接口同源` 及全量 `npm.cmd run check`
