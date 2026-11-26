# 05: 打包形态切换与快速最小打包入口

**What to build:** 将发布产物切换为单入口形态：`nexus-mcp.exe`（**托盘宿主**）+ `nexus-server.exe`（Node SEA **协议层**）+ `nexus-executor.exe`（**执行层**），淘汰 `启动.cmd` 与旧 `.vbs` 依赖，并拆出跳过 NSIS 安装包的快速最小打包入口供本地**热切换**复用。

**Blocked by:** 03

**Status:** done

- [x] `scripts/package.ts` 与 `package.json` 构建三件套产物：Rust **托盘宿主**输出为 `nexus-mcp.exe`，Node SEA **协议层**输出为 `nexus-server.exe`，Rust **执行层**保持 `nexus-executor.exe`，移除 `启动.cmd`
- [x] 抽离快速最小打包入口（只编执行器、托盘与 SEA 三件套到 staging 目录，跳过耗时的 NSIS 打包），供开发与**热切换**脚本直接调用
- [x] 更新 `scripts/installer/nexus-mcp.nsi` 与绿色 zip 说明文档：开始菜单/卸载信息指向新主入口 `nexus-mcp.exe`，并确保安装包内包含全部三个 exe
- [x] 验证无头开发与测试路径（`npm run dev`、`--stdio`、`npm run test`、`npm run smoke`）依然直跑**协议层**、不拉起系统托盘
- [x] 更新 `tests/packaging.test.ts` 与 `scripts/smoke-package.ts` 验收新三件套布局、配置优先级与 AGPL-3.0 元数据，并通过全量 `npm run check` 与 `npm run package:smoke`

## Comments

- 验收 1、2、3：`package.json` 新增 `build:tray` / `package:stage`，`scripts/package.ts` 输出 `nexus-mcp.exe` + `nexus-server.exe` + `nexus-executor.exe` + `使用说明.txt` 并支持 `--stage-only`，`scripts/installer/nexus-mcp.nsi` 指向新三件套并移除 `启动.cmd`。
- 验收 4、5：`tests/packaging.test.ts`（11/11 绿）与 `npm.cmd run package:smoke`（实测 `nexus-server.exe --stdio` 与 `nexus-mcp.exe` 托盘拉起协议层与面板全绿）。
