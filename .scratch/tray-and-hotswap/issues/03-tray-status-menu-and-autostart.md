# 03: 托盘状态灯联动、快捷菜单与开机自启开关

**What to build:** 让**托盘宿主**定时轮询**面板**本地 `/api/status` 驱动三色**状态灯**图标与悬浮提示，补齐全部高频右键菜单项（重启 MCP 服务、动态启停**隧道**、打开日志目录），并提供仅操作当前用户启动文件夹 `.lnk` 快捷方式的「开机自启」勾选开关。

**Blocked by:** 02

**Status:** done

- [x] **托盘宿主**定时轮询 `GET /api/status`，按「绿 = 服务与**隧道**均就绪，黄 = 启动中或隧道未连/未配置，红 = 异常」实时切换托盘图标颜色与悬浮提示文本
- [x] 右键菜单提供「重启 MCP 服务」（调 `/api/service` 重置**会话**与**执行层**，不动**隧道**）
- [x] 右键菜单提供「启动隧道」/「停止隧道」（随 `/api/status` 返回的隧道状态动态切换文案并调用 `/api/tunnel`）
- [x] 右键菜单提供「打开日志目录」（在资源管理器中打开**服务日志**目录）
- [x] 右键菜单提供「开机自启」勾选开关：勾选时在当前用户启动文件夹创建指向当前 `nexus-mcp.exe` 的 `nexus-mcp.lnk`，取消时删除该 `.lnk`，不修改系统注册表；支持环境变量覆盖启动文件夹路径以便测试
- [x] 通过 `cargo test` 验证三色**状态灯**与菜单文案的状态映射，以及临时启动文件夹内 `.lnk` 的创建、检测与删除闭环，并通过全量 `npm run check`

## Comments

- 验收 1、6：`crates/tray/src/status_mapper.rs` > `all_healthy_maps_to_green`、`connecting_or_unconfigured_tunnel_maps_to_yellow`、`stopped_service_or_down_tunnel_maps_to_red`、`invalid_json_maps_to_red_unreachable`。
- 验收 2、3、4：`crates/tray/src/main.rs` 与 `crates/tray/src/win_tray.rs` 接入每 2 秒 `/api/status` 轮询与 `RestartService` / `ToggleTunnel` / `OpenLogs` 命令处理。
- 验收 5、6：`crates/tray/src/autostart.rs` > `toggle_autostart_creates_and_removes_lnk_in_temp_dir`（验证临时启动文件夹 `.lnk` 创建、存在检测与幂等删除）。
