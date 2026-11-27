# 03: 从 src/panel.ts 拆出 src/panelPage.ts 纯前端模板模块

Status: done
Blocked-by: none

## 验收标准

- 新建 `src/panelPage.ts`，导出 `PANEL_PAGE`（由 `VERSION` 与 `TOOL_SUMMARY` 生成的完整 HTML 页面字符串）。
- `src/panel.ts` 引入 `PANEL_PAGE`，自身专注 HTTP 路由、鉴权与管控逻辑，体量减半至约 730 行。
- `npm.cmd run typecheck`、`npm.cmd run build` 与 `./node_modules/.bin/vitest run --pool=vmThreads tests/panel.test.ts` 全绿。
