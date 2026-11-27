# 03: 托盘宿主冷启动自动弹面板与 `--minimized` 开机静默

**What to build:** 让**托盘宿主**在普通冷启动（含 NSIS 安装完成勾选「现在启动」、用户平时手动双击桌面快捷方式）且**面板**就绪后自动在浏览器打开控制面板，同时为「开机自启」生成的启动文件夹 `.lnk` 附带 `--minimized` 参数保持开机静默不弹窗。

**Blocked by:** None (可立即开工)

**Status:** done

- [x] `nexus-mcp.exe` 解析命令行参数 `--minimized`：不带 `--minimized` 的冷启动在拉起协议层后轮询等待**面板**就绪（超时上限约 15 秒），就绪后自动调用 `open_panel_url` 打开一次浏览器。
- [x] 携带 `--minimized` 启动时跳过冷启动自动开浏览器，静默驻留系统托盘。
- [x] 托盘右键勾选「开机自启」创建启动文件夹 `nexus-mcp.lnk` 时，为快捷方式参数写入 `--minimized`（并保持已有无参 `.lnk` 的状态识别与重新勾选刷新）。
- [x] 单实例二次双击行为保持不变：托盘已在运行时再次启动 `nexus-mcp.exe` 仍直接打开浏览器**面板**并退出副进程。
- [x] 通过 `crates/tray/tests/lifecycle.rs` 真实进程缝隙（复用 `NEXUS_TRAY_OPEN_URL_LOG` 桩与独立临时端口）验证：不带 `--minimized` 会记录精确面板 URL、带 `--minimized` 不触发打开浏览器，以及开机自启 `.lnk` 参数单元测试通过。

## Comments

- 验收清单 1、2、5 → `crates/tray/tests/lifecycle.rs > cold_start_opens_panel_when_ready_unless_minimized`
- 验收清单 3、5 → `crates/tray/src/autostart.rs > autostart::tests::toggle_autostart_creates_and_removes_lnk_in_temp_dir`（验证 `.lnk` `Arguments == "--minimized"`）
- 验收清单 4 → `crates/tray/tests/lifecycle.rs > single_instance_intercepts_second_launch_and_opens_panel`（`nexus-tray` 9/9 通过）
