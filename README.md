# nexus-mcp

给云端 AI（Gemini 自定义 MCP、ChatGPT 连接器）用的本地 MCP 服务，暴露 9 个工具：
`read` / `write` / `edit` / `bash` / `glob` / `grep` / `job_start` / `job_output` / `job_kill`。

装在 Windows 上，只监听 `127.0.0.1`，外面通过 cloudflared 隧道访问。

## 装上就能用

本地跑一次 `npm run package`，产物落在 `release/` 下，两个随便挑一个：

- `nexus-mcp_0.1.0_x64-setup.exe` —— 安装包。双击，装到当前用户目录（不弹 UAC），装完桌面和开始菜单有快捷方式，卸载走「设置 → 应用」。
- `nexus-mcp-0.1.0-win64.zip` —— 绿色版。解压到任意目录就能用。

**三步上手：**

1. 双击桌面上的 `nexus-mcp`（或解压目录里的 `启动.cmd`），控制面板会在浏览器里打开。
2. 面板「连接信息」里直接显示云端要填的 MCP 地址和令牌，点「复制地址+令牌」一次带走
   （首次启动自动生成，同时打印在启动窗口里）。
3. 把地址和令牌填进 Gemini 自定义 MCP / ChatGPT 连接器的 Bearer 鉴权，就能调 9 个工具。

首次启动会在程序目录生成 `config.json` 和 `workspace/`（默认沙箱根）。卸载不会删这两个。

`bash` 与 `job_*` 需要机器上有 Git Bash（Git for Windows）；`read` / `write` / `edit` / `glob` / `grep`
不依赖任何外部命令。`grep` 首次使用会下载一份固定版本的 ripgrep 到全局缓存。

## 开机自启（可选）

安装包和绿色版**都不会**加开机自启。要的话，在
`%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup` 放一个 `nexus-mcp.vbs`：

```vbs
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = "C:\Users\<你>\AppData\Local\Programs\nexus-mcp"
sh.Run """C:\Users\<你>\AppData\Local\Programs\nexus-mcp\nexus-mcp.exe""", 0, False
```

结尾的 `0` 是隐藏窗口，`False` 是不等它退出。

**卸载程序不会删这个文件**（它只认自己装的东西）。卸载后记得手动删掉，否则每次开机都会弹一次找不到 exe 的报错。

## 升级 / 换版本

1. 先确认 8787 上没人监听：`Get-NetTCPConnection -LocalPort 8787 -State Listen`。
   有输出说明还有旧进程，用 `OwningProcess` 那一列的 pid 结束它：`Stop-Process -Id <pid>`。
2. 双击新的安装包装上。覆盖安装会自己 `taskkill` 掉 `nexus-mcp.exe` 和 `nexus-executor.exe`，
   但**杀不掉开发态起的 `node dist/index.js`**——端口冲突就是这么来的。
3. 重新启动服务。

装完启动报 `EADDRINUSE: address already in use 127.0.0.1:8787`，就是第 1 步没清干净。

## 配置

优先级：**环境变量 > 程序目录的 config.json > 内置默认**。

| 环境变量 | 对应 config.json 字段 | 说明 |
|---|---|---|
| `NEXUS_MCP_CONFIG` | — | 指定配置文件位置，直接顶掉程序目录的 `config.json` |
| `NEXUS_MCP_TOKEN` | `token` | Bearer 令牌 |
| `NEXUS_MCP_ROOT` | `root` | 沙箱根目录，越界访问直接报错 |
| `NEXUS_MCP_PORT` | `port` | MCP 端口，`panelPort` 未配时取 `port + 1` |

字段全表与校验规则见 `src/config.ts`。

## 分发

打包机需要 Rust 与 Node 24；目标机器什么都不用装。

```bash
npm run package        # 约 25 秒：esbuild 打 CJS → SEA 注入 → zip → NSIS 安装包
npm run package:smoke  # 拿刚出的产物在最小环境里自检：启动、连上、read、面板
```

产物落在 `release/`（不进版本库），文件名里的版本号取自 `package.json`：

| 文件 | 大小 | 说明 |
|---|---|---|
| `nexus-mcp_<版本>_x64-setup.exe` | 22.4MB | NSIS 安装包，按用户装到 `%LOCALAPPDATA%\Programs\nexus-mcp`，桌面 + 开始菜单快捷方式，卸载入口进「应用和功能」 |
| `nexus-mcp-<版本>-win64.zip` | 34.2MB | 绿色版，四个文件平铺：`nexus-mcp.exe`、`nexus-executor.exe`、`启动.cmd`、`使用说明.txt` |

发给别人之前要知道的：

1. 都没有签名，SmartScreen 首次会拦一次（「更多信息 → 仍要运行」），企业策略可能直接拦掉。要正经发就得买代码签名证书。
2. 两个 exe 必须在同一目录：`nexus-mcp.exe` 找不到 `nexus-executor.exe` 时，只有文件类工具能用，报错里会指出缺哪个文件。
3. 覆盖安装会先 `taskkill` 掉正在跑的 `nexus-mcp.exe` / `nexus-executor.exe`（杀不掉开发态的 `node dist/index.js`，见「升级 / 换版本」）；卸载只删程序文件，`config.json`、`workspace` 和你自己加的开机自启脚本都留着。
4. 第一次打包要联网取 NSIS 3.11（2.4MB，脚本里钉了 SHA-256 校验）；内网机器可以用 `NEXUS_NSIS_DIR` 指向已解压的 NSIS 目录跳过下载。
5. 默认 MCP 端口 8787、面板 8788；目标机器上被占了就改 `config.json` 的 `port` / `panelPort`。

## 开发

```bash
npm run build        # cargo build --release 构建执行器，再 tsc
npm run typecheck
npm run test         # vitest，只走 MCP 客户端入口
npm run test:rs      # Rust 侧
npm run smoke        # 起服务、列出工具、调一次 read
npm run check        # build + vitest + cargo test + smoke，提交前必须全绿
npm run package      # 出 release/ 下的 zip 与 NSIS 安装包
npm run package:smoke # 在最小环境下验证打包产物（启动、连上、read、面板）
```

目录：`src/` TypeScript 侧（MCP 协议、工具、HTTP、面板、执行器客户端）、`crates/executor/` Rust 执行器、
`scripts/` 自检与打包、`docs/research/` 调研笔记。

动手前读 `AGENTS.md`（命令、禁忌、踩过的坑），调研结论在 `docs/research/`。
