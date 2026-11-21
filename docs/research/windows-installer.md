# Windows 安装包：参考 Nexus 的路线做 nexus-mcp 安装器

调研时间 2026-11-22。结论先说：**Nexus 走的是 Tauri 2 bundler + NSIS，产物是按用户安装的 `-setup.exe`**。nexus-mcp 没有 GUI，借不了 Tauri bundler，但可以直接用 Tauri 官方发布的那份 NSIS 3.11 zip（免安装，2.4MB）直接写 `.nsi` 脚本，产出同等形态的 `nexus-mcp_0.1.0_x64-setup.exe`，无需在机器上装 NSIS。

## 1. Nexus 的实际做法（本地源码，一手）

| 事实 | 证据 |
|---|---|
| Windows target 只有 `nsis`，没有 msi/wix | `apps/desktop/src-tauri/tauri.conf.json:30-36`（`"targets": ["nsis", "dmg", "app", "deb", "appimage"]`） |
| 按用户安装，不需要管理员 | 同上 `:51-57` `"installMode": "currentUser"` |
| 安装期唯一定制是杀进程 hook | `apps/desktop/src-tauri/installer-hooks.nsi:1-17`，`NSIS_HOOK_PREINSTALL` / `NSIS_HOOK_PREUNINSTALL` 里 `nsExec::Exec 'taskkill /F /IM ...'` |
| 运行时资源靠「exe 同目录 / resource_dir 下找 resources」 | `apps/desktop/src-tauri/src/main.rs:362-419`、`:513-542` |
| 打包前先把 node.exe、server、runner、各 Rust exe 收进 resources | `scripts/prepare-bundled-resources.ts:17-26`、`:121-156`、`:391-448` |
| 产物命名与发布 | `README.md:213` `Nexus_1.3.2_x64-setup.exe`；`.github/workflows/release-windows.yml:13` job 名 `Build & Package Windows Installer (Tauri 2 NSIS)` |
| 配置不落安装目录 | `packages/shared/src/config/loader.ts:49-58` 配置文件按 cwd / 环境变量找；运行时数据落 `%LOCALAPPDATA%\LocalBridge`（`main.rs:2887-2902`） |

## 2. Tauri 官方文档对 NSIS 的说明（一手）

来源：https://v2.tauri.app/distribute/windows-installer/ （抓取于 2026-11-22）

- Windows 两种产物：`.msi`（WiX v3，只能在 Windows 上构建）与 `-setup.exe`（NSIS）。
- `bundle.windows.nsis.installMode` 三档：默认（不设置）= 仅当前用户、**不需要管理员**、装到 `%LOCALAPPDATA%`；`perMachine` = 装到 `C:/Program Files` 类目录、需要管理员；`both` = 让用户选。
- NSIS 产物输出到 `target/.../release/bundle/nsis/`，文件名以 `-setup.exe` 结尾。
- 页面未覆盖：默认 target 集合、完整文件名模板、静默安装参数（`/S`）。

## 3. 本机工具链现状（实测，2026-11-22）

| 项 | 结果 |
|---|---|
| NSIS | **未安装**（`C:\Program Files (x86)\NSIS` 不存在，PATH 上无 `makensis`） |
| Inno Setup | 未安装 |
| WiX 3.14 | 已缓存：`%LOCALAPPDATA%\tauri\WixTools314`（含 `candle.exe` / `light.exe`），可产 MSI，但手写 WiX XML 成本远高于 NSIS 脚本 |
| winget | `v1.29.380` 可用，`NSIS.NSIS` 版本 3.13（按机安装，会走 UAC） |
| Tauri 用的 NSIS 3.11 zip | `https://github.com/tauri-apps/binary-releases/releases/download/nsis-3.11/nsis-3.11.zip` 实测 HTTP 200、2,361,546 字节；解压即用 `makensis.exe`，**不需要安装** |

结论：**走 Tauri 同款 NSIS 3.11 免安装 zip**，既对齐参考仓库的工具链，又不动系统。

## 4. 待实测确认的 NSIS 机制（未取到一手文档）

`nsis.sourceforge.io` 全部参考页被 Cloudflare 人机验证挡住，抓不到正文。下面几条是通行做法，**下载 NSIS 后要用 `Docs/` 本地文档与实测复核**：

1. `RequestExecutionLevel user` + `SetShellVarContext current`（默认）是「按用户安装、不弹 UAC」的配套组合；两者混搭（user + all）会静默失败。
2. 按用户安装目录惯例用 `$LOCALAPPDATA\Programs\<App>`；`$LOCALAPPDATA` 是 NSIS 3.x 才有的变量。
3. 卸载器要 `WriteUninstaller` 生成，并在 `HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\<Key>` 下写 `DisplayName` / `DisplayVersion` / `UninstallString`，才会出现在「应用和功能」里。
4. 安装/卸载两侧的 `SetShellVarContext` 必须一致，否则会删错用户的开始菜单。
5. `/S` 静默安装；`/D=` 指定安装目录（必须放命令行末尾，不带引号）。
6. 装完立刻起服务不能靠 `Exec` 阻塞等待，需 `ExecShell` 或 `nsExec::ExecToLog` 区别对待。

## 5. 对 nexus-mcp 的落点建议

- 安装内容：`nexus-mcp.exe`（Node SEA 产物）+ `nexus-executor.exe` + `config.json` + `启动.cmd` + `使用说明.txt`，与 zip 内容一致。
- 安装目录：`$LOCALAPPDATA\Programs\nexus-mcp`，按用户、免 UAC（与 Nexus 一致）。
- 快捷方式：开始菜单 `nexus-mcp` 组 + 可选桌面图标。
- 卸载：杀 `nexus-mcp.exe` / `nexus-executor.exe`（照 Nexus 的 hook 手法），默认保留 `config.json` 与 `workspace/`，二次确认后可选删除。
- 版本号：`package.json` → NSIS `VIProductVersion` / `VIAddVersionKey` + 安装包文件名 `nexus-mcp_0.1.0_x64-setup.exe` + 面板页脚。

## 6. 与票 11 的冲突（需要改票）

`11-packaging.md` 第一条验收写的是「产出单个 zip」。改成安装包后，这条需要重写成「产出 NSIS 安装包 + 可选同时产出 zip」，并补一条「控制面板可见版本号、应用和功能里可见版本」。

## 7. 未决

工具链选择（NSIS vs WiX/MSI）、安装范围（按用户 vs 按机）、config 落点（安装目录 vs `%APPDATA%`）、是否同时保留 zip —— 见对话中的决策清单。
