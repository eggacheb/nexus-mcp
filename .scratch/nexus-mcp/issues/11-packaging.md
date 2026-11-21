# 11: 分发打包

**What to build:** 把整套东西打成发布件：NSIS 安装包（对齐 Nexus 的 Tauri-NSIS 路线）+ 绿色版 zip。别人下载装完、填一个令牌就能用，不需要在机器上装 Rust 或 Node。这是最后一张票，前面全部跑通之后再做。

**Blocked by:** 03, 04, 05, 06, 07, 08, 09, 10

**Status:** done（2026-11-22，`npm run check` 全绿：vitest 130 条 + cargo 112 条 + smoke；`npm run package:smoke` 全绿；本机静默安装/卸载各走一遍，卸载保留 config.json 与 workspace；双面审查已过，修正项见「审查结论」）

- [x] 产出发布件：安装包 `nexus-mcp_0.1.0_x64-setup.exe` + zip `nexus-mcp-0.1.0-win64.zip`，内容都是两个可执行文件 + 启动脚本 + 简短说明
- [x] 装完/解压后双击启动脚本即可运行，不需要安装 Node、Rust 或任何开发工具链
- [x] 首次运行在缺少配置时生成默认配置，不直接崩溃
- [x] 配置读取优先级正确：环境变量 > 可执行文件同目录 > 内置默认
- [x] 在没装过开发工具链的环境里验证：启动、连上、调一次 `read`（最小环境模拟，见下）
- [x] 面板在打包版本里能正常打开，地址与端口正确
- [x] 版本号写进产物（安装包版本资源、安装包文件名、面板页头），面板上可见
- [x] 附一份最短上手步骤（三步以内），不写长篇文档
- [x] 桌面与开始菜单快捷方式（拍板补充），卸载入口进「应用和功能」，卸载保留 config.json 与 workspace

## Comments

**产物**（`npm run package`，25 秒左右）：

- `release/nexus-mcp_0.1.0_x64-setup.exe`（22.4MB）：NSIS 安装包，按用户装到 `%LOCALAPPDATA%\Programs\nexus-mcp`，`RequestExecutionLevel user` 不弹 UAC，桌面 + 开始菜单快捷方式，卸载器写 HKCU Uninstall 键。
- `release/nexus-mcp-0.1.0-win64.zip`（33.1MB）：同样的 4 个文件平铺。
- 两边内容一致：`nexus-mcp.exe`（Node 24 SEA 单文件，90MB 未压缩）、`nexus-executor.exe`、`启动.cmd`、`使用说明.txt`。

**实现**：

- `src/paths.ts`：`node:sea` 的 `isSea()` 判定打包态，`appRoot` = exe 目录（开发态仍是仓库根）。
- `src/index.ts`：顶层 await 收进 `main()`——SEA 只吃 CJS，esbuild 打 CJS 时顶层 await 是硬错误；新增 `--open-panel`。
- `src/config.ts`：`configFilePath()` 改为程序目录；环境变量 `NEXUS_MCP_TOKEN` / `NEXUS_MCP_ROOT` / `NEXUS_MCP_PORT` 覆盖；文件不存在时写默认配置（随机令牌 + `workspace` 根）。
- `src/version.ts`：版本单一来源，`server.ts` / 面板 / 安装包文件名都从这里来。
- `scripts/package.ts`：esbuild 打 CJS → `node --experimental-sea-config` → postject 注入 → 拷执行器 → 写脚本 → zip → makensis。
- `scripts/installer/nexus-mcp.nsi`：MUI2 四页、简中、`/INPUTCHARSET UTF8`。
- `scripts/smoke-package.ts`：把 `build/package` 当「解压后的目录」，最小环境跑一遍。

**验收对照**（AGENTS 约定：没有断言的验收线不算过）：

1. 发布件产出 → `scripts/package.ts` 里 `requireFile` 卡住 blob、zip、setup 三个产物，任一缺失即非零退出；`release/` 实测两个文件都在。
2. 不装工具链 → `npm run package:smoke` 的 `minimalEnv()`：PATH 里只有 `System32` 与 `SystemRoot`（没有 Node / Rust / Git 目录），`NEXUS_GIT_BASH` 指向不存在的路径；仍能起来、能 `read`。另外真机静默装了一遍（`setup.exe /S`），装好的 `nexus-mcp.exe --stdio` 直接跑通并生成配置。`启动.cmd` 共 6 行（`chcp` + `cd` + 一行提示 + 带 `--open-panel` 启动 + errorlevel 暂停），双击动作没有桌面会话可实操。
3. 首次运行生成配置 → `tests/packaging.test.ts`「首次运行缺配置时生成默认配置」+ 冒烟的「首次运行生成了 config.json / 令牌是 32 位 hex」。
4. 配置优先级 → `tests/packaging.test.ts` 五条：env > file、file > 默认、空串视为未设置、`NEXUS_MCP_CONFIG` 顶掉程序目录（并断言它不等于 appRoot 的路径）、没有 override 时回落到 `appRoot/config.json`；另有一条断言开发态 `isPackaged=false`、`appRoot` 就是仓库根。
5. 干净环境验证 → **模拟**，不是真机：`npm run package:smoke` 全部断言通过（9 个工具 / read 回读探针 / 首次生成配置 / 面板端口与版本）。真机待小白拿走安装包验。
6. 面板地址与端口 → 冒烟断言 `status.service.port`、`status.service.url`（`http://127.0.0.1:<port>/mcp`）、`status.panelPort` 与写入配置一致，且页面在 `panelPort` 上真能取到。
7. 版本号 → `tests/packaging.test.ts`（`VERSION` == `package.json`）+ `tests/panel.test.ts`「版本号可见」断言 HTML 里直接印出 `v0.1.0`（服务端渲染，不依赖页面脚本）+ 冒烟断言 `/api/status` 的 `version`；安装包 exe 的 `VIProductVersion` 由 `makensis` 写入（`/DAPP_VERSION` 传参），实测读到的 `ProductVersion` 为 0.1.0。
8. 三步上手 → `README.md`「三步上手」+ 包内 `使用说明.txt`，都是三步。
9. 快捷方式与卸载 → `.nsi` 的 `CreateShortCut`（桌面 + 开始菜单）与 `HKCU\...\Uninstall` 键；卸载只 `Delete` 程序文件，注释与实现都不动 `config.json` / `workspace`。

**与票面的偏差（拍板项之外，实现时必须做的两处）**：

- 第一条验收原文是「产出单个 zip」。按小白要求改成「安装包 + zip」，理由：Nexus 的发布件是安装包，zip 给绿色版。
- `shell: auto` 在打包版里缺 Git Bash 时**不再启动即崩**，降级成启动警告 + 真用 `bash` / `job_*` 时报错（`src/config.ts` 的 `validateShell`）。不改这条，"不需要任何开发工具链"这条验收做不到——机器上没 Git Bash 就根本起不来。开发态和显式 `shell: "git-bash"` 仍然硬失败，`tests/bash.test.ts`「shell 为 auto 但找不到 Git Bash 时启动即报错」照旧通过。

**实机安装验证**（2026-11-22，本机，静默 `/S`）：

- 装到 `%LOCALAPPDATA%\Programs\nexus-mcp`，四个文件 + `uninstall.exe`，中文文件名正常。
- 桌面快捷方式、开始菜单 `nexus-mcp` 组、`HKCU\...\Uninstall\nexus-mcp` 三处都在；`DisplayVersion` 0.1.0，`UninstallString` 指向安装目录。
- 安装包自身的版本资源：`ProductName=nexus-mcp`、`ProductVersion=0.1.0`、`FileDescription=nexus-mcp 安装程序`、`CompanyName=nexus-mcp`。
- 装好的 exe 跑 `--stdio`：生成 `config.json`（令牌 hex32）与 `workspace/`，日志带 `v0.1.0`。
- 卸载 `/S`：程序文件、桌面与开始菜单快捷方式、注册表键全部清掉，`config.json` 与 `workspace/` 保留 —— 与设计一致。验证完已手动清掉这份残留，机器回到安装前状态。

**已知边界**：

- 令牌不上面板状态接口（沿用 `tests/panel.test.ts`「状态灯来自真实探测」里 `not.toContain(TOKEN)` 的既有约定），首次生成时打到控制台 + 写进 `config.json`。
- `nexus-mcp.exe` 的文件属性里 `ProductName` 仍是 `Node.js 24.12.0`：SEA 产物是 node.exe 副本，版本资源跟着 node 走。安装包 exe 的版本资源、安装包文件名、面板页头、`使用说明.txt` 都是 0.1.0。要改 app exe 的版本资源得再引入 PE 资源改写工具，本轮不做。
- `nexus-executor.exe` 仍动态链接 `VCRUNTIME140.dll`（cargo 默认 MSVC 目标），干净机器若没有 VC++ 运行库会缺 DLL。没改，因为要单独做 `+crt-static` 构建配置，先记在这里。
- 安装包与 exe 都未签名，SmartScreen 首次会拦一次「更多信息 → 仍要运行」。
- 「没装过开发工具链的机器」用最小环境模拟，没有第二台真机。

**复用来源**：NSIS 运行时用 Tauri bundler 同一份 `nsis-3.11.zip`（`tauri-apps/binary-releases`），脚本里钉了 SHA-256；安装脚本本身是新写的，未搬 Nexus 的 `installer-hooks.nsi`（只借了「安装/卸载前 taskkill」这个做法）。

**审查结论**（2026-11-22 双面）：

- 标准面已改：`Compress-Archive` 优先走 pwsh 7（AGENTS 的 UTF-8 约定），只有 5.1 的机器才退回 `powershell.exe`；`saveConfig` 挤在一行的花括号拆开；`scripts/**/*.ts` 纳入 `tsconfig.tests.json`，`npm run typecheck` 现在盖住打包脚本（顺带给 postject 补了 `scripts/types/postject.d.ts`）。
- 票面面已改：面板版本号改成服务端直接渲染（原来只断言占位符，等于没断言版本）；冒烟补 `service.url` 与 `root` 的精确断言（原来只有 `endsWith("workspace")`）；`configFilePath()` 补上「无 override 回落 appRoot」与开发态 `paths.ts` 的用例。
- 判断题未采纳：`freePort` / `waitForPort` 与 `tests/support/server.ts` 重复 —— 打包冒烟脚本要能脱离测试目录单独跑，故意自带一份；`isPackaged ?` 的判断点多，但都是「目录取值」这一件事的不同侧面，抽出来反而多一层间接。
- 已知例外：`tests/packaging.test.ts` 直接 import `src/config.ts`，没有走 MCP 客户端入口。AGENTS 那条约定针对的是工具行为，配置加载不是工具；同理 `bash.test.ts` 早就直接 import `src/executor.ts` 的辅助函数。
