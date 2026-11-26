# 02: Rust 托盘宿主基础骨架（单实例、拉起协议层与退出树杀兜底）

**What to build:** 在 Rust workspace 新增极轻量的 Win32 原生 GUI 子系统**托盘宿主**（无黑框、零前端框架），实现命名 Mutex 单实例保护、无窗口拉起同目录 `nexus-server.exe` 并绑定 Windows Job Object、基础右下角托盘图标与「打开控制面板」「退出（同时停止服务与隧道）」入口，以及优雅全停超时 3 秒后的强制**树杀**兜底。

**Blocked by:** 01

**Status:** done

- [x] `crates/tray` 加入 Rust workspace 并以 Win32 GUI 子系统编译（`#![windows_subsystem = "windows"]`），启动不弹控制台黑框，且许可证元数据与仓库整体 AGPL-3.0 一致
- [x] 启动时申请 Windows 命名 Mutex 做单实例保护；若已有实例在运行，直接用默认浏览器打开**面板**地址并退出新进程
- [x] 无窗口拉起同目录 `nexus-server.exe`（支持测试环境变量注入 stub 可执行文件、临时面板端口与无头模式），并将子进程纳入 Windows Job Object 管理
- [x] 右下角系统托盘支持左键双击打开**面板**，右键提供「打开控制面板」与「退出（同时停止服务与隧道）」
- [x] 触发退出时先调用 01 的优雅全停入口（含停**隧道**），若 3 秒内未退出则通过 Job Object 强制**树杀**兜底，确保无孤儿进程残留
- [x] 在 `crates/tray` 通过 `cargo test` 进程级无头集成测试验证单实例拦截、子进程拉起、优雅退出与 3 秒超时树杀兜底（进程测试串行加锁），并通过全量 `npm run check`

## Comments

- 验收 1：`crates/Cargo.toml` 加入 `tray`、`crates/tray/Cargo.toml` 标注 `license = "AGPL-3.0"`、`crates/tray/src/main.rs` 启用 `#![cfg_attr(not(test), windows_subsystem = "windows")]`。
- 验收 2、3、5、6：`crates/tray/tests/lifecycle.rs` > `single_instance_intercepts_second_launch_and_opens_panel`（验证命名 Mutex 拦截重复启动并打开面板、拉起子进程、`/api/shutdown` 带 `includeTunnel: true` 优雅退出）。
- 验收 3、5、6：`crates/tray/tests/lifecycle.rs` > `unresponsive_server_is_tree_killed_after_timeout_without_orphans`（验证无响应子进程与孙进程在超时后随 Job Object 树杀零孤儿残留）。
- 验收 4：`crates/tray/src/win_tray.rs` 提供 Win32 托盘左键双击打开面板与右键「打开控制面板」「退出（同时停止服务与隧道）」。
