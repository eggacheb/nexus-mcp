# 运行态开发态隔离与防失联热切换

Status: accepted

此前用 `npm run dev` 在源码仓内原地自举承载云端连接器，既会在重编 Rust 执行器时触发 Windows `os error 5` 文件锁，又有改坏代码把正在用的 MCP 服务直接锯断失联的风险。现决定将承载连接器的运行态（默认安装目录 `AppData\Local\Programs\nexus-mcp\`）与源码开发仓物理隔离，并提供供 AI 自主触发的延迟热切换流程：先做最小产物打包与临时端口 smoke，工具调用返回后延迟 1–2 秒备份旧 exe 为 `.prev`、替换并拉起新进程，10 秒内探测 `127.0.0.1:8787/health` 不过则自动还原 `.prev` 回滚，全程保持隧道不断。

## Considered Options

- **仓库内原地自举（执行器影子拷贝 + 文件监听自动重启）**：仍存在改出启动错误导致连接器彻底失联的风险，且开发态与打包分发态长期脱节。
- **强制人工手动升级切换**：最稳但打断 AI 无人监管的自我调试闭环。
- **移除执行层默认 `MSYS_NO_PATHCONV=1` 以兼容 pnpm `npm` wrapper**：会导致 `cmd /c`、`taskkill /F` 等带斜杠参数的 Windows 命令出现隐蔽路径转换错误，因此保留该环境变量，改为用单一部署脚本封装本地打包与热切换。

## Consequences

- `nexus-mcp.exe`（托盘宿主）哈希未变时，热切换由运行中的托盘宿主原地停换 `nexus-server.exe` / `nexus-executor.exe`，托盘图标不闪烁；仅当托盘宿主自身变更时，才交由脱离进程树的临时切换器替换托盘本身。
- 热切换严格保留运行目录中的 `config.json` 与 `oauth-store.json` 不动。
