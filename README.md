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
2. 面板上的「MCP 地址」是云端要填的地址；令牌在安装目录 `config.json` 的 `token` 字段（首次启动自动生成，同时打印在启动窗口里）。
3. 把地址和令牌填进 Gemini 自定义 MCP / ChatGPT 连接器的 Bearer 鉴权，就能调 9 个工具。

首次启动会在程序目录生成 `config.json` 和 `workspace/`（默认沙箱根）。卸载不会删这两个。

`bash` 与 `job_*` 需要机器上有 Git Bash（Git for Windows）；`read` / `write` / `edit` / `glob` / `grep`
不依赖任何外部命令。`grep` 首次使用会下载一份固定版本的 ripgrep 到全局缓存。

## 配置

优先级：**环境变量 > 程序目录的 config.json > 内置默认**。

| 环境变量 | 对应 config.json 字段 | 说明 |
|---|---|---|
| `NEXUS_MCP_CONFIG` | — | 指定配置文件位置，直接顶掉程序目录的 `config.json` |
| `NEXUS_MCP_TOKEN` | `token` | Bearer 令牌 |
| `NEXUS_MCP_ROOT` | `root` | 沙箱根目录，越界访问直接报错 |
| `NEXUS_MCP_PORT` | `port` | MCP 端口，`panelPort` 未配时取 `port + 1` |

字段全表与校验规则见 `src/config.ts`。

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
