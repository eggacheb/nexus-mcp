# Rust 原生托盘宿主与隧道同生共死

Status: accepted

此前开机自启依赖两份无窗口 `.vbs` 脚本分别拉起服务与 `cloudflared`，既看不到状态也难以安全退出，且 `tunnel.ts` 刻意让隧道 `detached` 独活。现决定在 `crates/` 新增极轻量的 Rust 原生 Win32 GUI 托盘宿主作为主入口 `nexus-mcp.exe`（原 Node SEA 协议层改名为同目录 `nexus-server.exe`），通过复用面板本地 HTTP API（`/api/status`、`/api/service`、`/api/tunnel`）驱动状态灯图标与右键快捷菜单（含用户启动文件夹 `.lnk` 开机自启勾选），并开启配置化随服务自启隧道（`tunnel.autoStart` 默认 `true`）；点托盘「退出」时连同协议层、执行层与隧道整棵树杀全停（演进补充 ADR-0004 与 ADR-0005）。

## Considered Options

- **Electron / Tauri 桌面应用**：体积与内存开销过大，且违背「设置与日志留在浏览器面板」的轻量定位。
- **Node SEA + PowerShell/WinForms 托盘子进程**：启动慢、占 .NET CLR 内存，且 Node SEA 仍为控制台子系统难以消除黑框。
- **独立 `nexus-tray.exe` 壳**：对外暴露双入口，用户难以分辨应启动哪个 exe。

## Consequences

- `npm run dev`、`--stdio` 与自动化测试仍直跑协议层，不拉起系统托盘，保持无头可测。
- 重复双击 `nexus-mcp.exe` 通过命名 Mutex 拦截，直接用浏览器打开面板并退出新进程。
- 旧的 `nexus-mcp.vbs`、`nexus-tunnel.vbs` 与打包内的 `启动.cmd` 全部淘汰。
