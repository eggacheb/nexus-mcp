# 零配置上手、单通道三层隧道与本地 Release 分发 规格

Status: ready-for-agent

## Problem Statement

目前把 `nexus-mcp` 的 GitHub 仓库链接分享给他人时，新用户面临四个明显的上手与分发断点：

1. **GitHub 首页与发布链路面向开发者而非使用者**：`README.md` 开头是 `npm run package` 本地构建说明，仍残留已删除的 `启动.cmd`、手动 `nexus-mcp.vbs` 开机脚本与手杀 8787 步骤；仓库也没有一键本地发布到 GitHub Releases 的脚本与校验和清单。
2. **首次启动缺少可见反馈**：安装完成勾选启动或手动双击 `nexus-mcp.exe` 后，**托盘宿主**只静默缩进系统托盘，不自动弹出浏览器**面板**，新用户容易误以为没启动。
3. **公网接入零配置门槛过高**：目前只支持自备域名 + 手写 `config.yml` 的**命名隧道**；新用户打开**面板**后只看到 `http://127.0.0.1:8787/mcp`，无法直接填进云端**连接器**（Gemini / ChatGPT），且缺乏免买域名的固定地址方案。同时，已配好**命名隧道**且本机也安装了 Tailscale 的老用户需要明确的单通道互斥保护，不能让两条公网通道同时开启或互相覆盖。
4. **安装包升级与卸载细节不干净**：NSIS 覆盖安装/卸载直接 `taskkill /F` 强杀进程（未优先经**托盘宿主**优雅退出，容易留下孤儿**隧道**），卸载时也不清理托盘勾选生成的开机自启 `.lnk` 与**热切换**残留文件（`.prev`、`.tray-control.json`）。

## Solution

围绕「收到 GitHub 链接 → 下载安装包 → 双击启动 → 1 分钟连上云端 AI」打通端到端体验，同时遵守不启用 GitHub Actions（ADR-0003）与精简安装包（ADR-0010）约束：

1. **三层公网接入 + 单通道互斥**：在**面板**提供显式的**隧道**渠道切换（`关闭` / **临时隧道** / `Tailscale Funnel` / **命名隧道**），同一时刻仅激活一种渠道，切换前自动停掉旧渠道：
   - **临时隧道**：零账号、零域名，用户点击「一键开启临时隧道」时按需下载固定版本并校验 SHA-256 的 `cloudflared.exe` 到用户全局缓存，几秒内捕获 `https://<随机>.trycloudflare.com` 回填到连接信息卡，并明示重启后会更换域名；
   - **Tailscale Funnel**：自动检测本机 `tailscale.exe` 安装与登录状态，提供一键开启/关闭（`tailscale funnel --bg <mcpPort>` / `off`）、首次授权开关链接引导，开启后自动回填永久固定 `*.ts.net` 地址；
   - **命名隧道**：完全兼容既有 `config.yml` 方案；已配置**命名隧道**的用户默认保持**命名隧道**激活，绝不被本机已登录的 Tailscale 自动接管或覆盖 `tunnelUrl`。
2. **冷启动自动弹出控制面板**：**托盘宿主**普通冷启动（含 NSIS 安装完成勾选启动、平时双击桌面快捷方式）在**面板**就绪后自动在浏览器打开**面板**；勾选「开机自启」创建的启动文件夹快捷方式自动附加 `--minimized` 参数，开机保持静默驻留托盘。
3. **NSIS 生命周期收尾**：保持 NSIS 安装包 + 绿色 zip 双产物；覆盖安装与卸载前先尝试经**托盘宿主**控制端口优雅退出，超时/失败再 `taskkill` 兜底；卸载时清理启动文件夹 `.lnk`、`.prev` 备份与 `.tray-control.json`，严格保留 `config.json`、`oauth-store.json` 与 `workspace/`。
4. **本地一键 Release 与用户向 `README.md`**：新增 `npm run release [-- <version>] [--publish]`，串联版本号同步、`npm run check`、`npm run package` + `package:smoke`、`SHA256SUMS.txt` 生成与本机 `gh release create`（默认建 Draft）；重写 `README.md` 顶部为「去 Releases 下载 → 双击安装 → 3 步连上」并清理所有过时描述。

## User Stories

1. 作为收到 GitHub 链接的新用户，我想在仓库首页第一屏直接点进 Releases 下载 Windows 安装包，并按 3 步说明完成安装与连接，而不必看懂开发构建命令。
2. 作为刚装完 `nexus-mcp` 的新用户，我想勾选安装完成的「现在启动」（或平时双击桌面图标）后，浏览器自动弹出控制**面板**，一眼看到连接信息与公网接入入口。
3. 作为勾选了托盘「开机自启」的日常用户，我想电脑重启后 `nexus-mcp` 静默驻留右下角托盘，不自动弹浏览器窗口打扰工作。
4. 作为想先试用 1 分钟的新用户，我想在**面板**点一下「一键开启临时隧道」，无需注册 Cloudflare 账号或买域名，自动拿到 `https://*.trycloudflare.com/mcp` 复制进 Gemini / ChatGPT 立即跑通，并清楚知道重启后会换域名。
5. 作为不想买域名但想要永久固定地址的用户，我想在装好并登录 Tailscale 后，在**面板**一键开启或关闭 Tailscale Funnel；若账号首次未开 Funnel 开关，**面板**能直接把一次性授权链接渲染成可点按钮引导我启用，完成后自动把 `*.ts.net` 填进连接信息。
6. 作为已经配好 Cloudflare **命名隧道**、同时本机也装着并登录了 `tailscale.exe` 的老用户，我想程序继续默认使用我的**命名隧道**，绝不自动启用 Tailscale 或覆盖我的 `tunnelUrl`；当我在**面板**主动切换渠道时，程序自动先停掉当前渠道再启动新渠道，绝不同时暴露两个公网入口。
7. 作为覆盖升级或卸载 `nexus-mcp` 的用户，我想安装器先优雅通知托盘退出（避免残留孤儿**隧道**），卸载时顺手清掉托盘创建的开机自启快捷方式与热切换残留，但保留我的 `config.json`、`oauth-store.json` 与 `workspace/`。
8. 作为项目维护者，我想在本机跑一条 `npm run release -- <version>` 命令，就自动完成版本号同步、全量测试与冒烟、打出安装包 + 绿色 zip + `SHA256SUMS.txt`，并在本机 `gh` 可用时默认创建 GitHub Draft Release（传 `--publish` 可直接发布），全程不依赖 GitHub Actions。

## Implementation Decisions

### 1. 三层隧道模型与单通道互斥

- **渠道枚举**：定义统一公网渠道模式 `tunnelMode`：`none`（关闭/仅本机）| `quick`（**临时隧道**）| `tailscale`（Tailscale Funnel）| `named`（**命名隧道**）。
- **向后兼容默认推导**：
  - 若 `config.json` 未显式写 `tunnelMode`：只要存在既有 `tunnel`（**命名隧道**）配置段，自动推导为 `named`，保持老用户 100% 行为不变；否则推导为 `none`。
  - 无论本机是否装有并登录了 `tailscale.exe`，都不在启动时自动从 `none` 或 `named` 切换到 `tailscale`。
- **切换状态机（单通道互斥）**：
  - 面板暴露统一渠道切换与状态接口（扩展 `GET /api/status` 返回当前 `tunnelMode`、各渠道可用性与探测状态，以及切换/启停接口）。
  - 从渠道 A 切到渠道 B 时，协议层必须先执行 A 的停止逻辑（停 `cloudflared` 进程并暂停**隧道守护**，或执行 `tailscale funnel --https=443 off`），确认释放后再启动 B 并更新当前对外暴露地址与配置持久化。
  - **状态灯**（面板与**托盘宿主**）统一反映当前激活渠道的健康状态：`none` 时不报红灯；`quick` 看临时 `cloudflared` 存活与已拿到 `trycloudflare.com` URL；`tailscale` 看 `tailscale` 登录与 Funnel 映射端口状态；`named` 保持既有 `127.0.0.1:20241/ready` 本地指标判定。
  - **命名隧道**的 `tunnelUrl` 单独保留，切去**临时隧道**再切回**命名隧道**时不丢失用户原有的固定域名配置。

### 2. 临时隧道（Cloudflare Quick Tunnel）与按需下载 `cloudflared`

- **按需缓存机制**：复用执行层 `ripgrep` 的全局缓存下载思路（不塞进安装包），按顺序查找 `cloudflared.exe`：① 配置显式路径 → ② 系统常见安装目录 / `PATH` → ③ 本程序用户缓存目录（如 `%LOCALAPPDATA%\nexus-mcp\bin\cloudflared.exe`）。缺失时在用户点击「一键开启临时隧道」后按 pinned 版本下载并做 SHA-256 校验（走系统代理 `NODE_USE_ENV_PROXY=1`），测试环境支持通过环境变量注入模拟下载 URL 与二进制路径。
- **拉起与 URL 捕获**：以 `cloudflared tunnel --url http://127.0.0.1:<mcpPort> --no-autoupdate` 无窗口拉起，实时解析输出捕获 `https://<子域>.trycloudflare.com`；拿到后更新面板连接信息卡的 `mcpUrl` 为 `<公网地址>/mcp`，并在 UI 显著标注「临时域名，重启后会变更」。
- **退出清理**：**托盘宿主**安全退出（`POST /api/shutdown` 且 `includeTunnel=true`）时一并停掉正在运行的**临时隧道**。

### 3. Tailscale Funnel 一键集成

- **检测与状态**：通过查找 `PATH` 与默认安装目录定位 `tailscale.exe`（测试环境支持环境变量覆盖），调用 `tailscale status --json` 解析登录态（`BackendState === "Running"`）与本机固定域名（`Self.DNSName` 去除尾随 `.`），结合 `tailscale funnel status --json`（或文本输出回退）判断当前是否已将 443 映射到本机 `<mcpPort>`。
- **一键开启与首次授权引导**：点击开启执行 `tailscale funnel --bg <mcpPort>`。若 CLI 输出包含 Tailscale Funnel 启用授权链接（如 `https://login.tailscale.com/f/funnel...`），后端捕获该 URL 返回给前端，面板渲染为可点击按钮「去 Tailscale 后台启用 Funnel」并提示「开启后再次点击一键开启」。开启成功后，将 `https://<DNSName>` 持久化为 Tailscale 渠道地址并显示在连接信息卡。
- **一键关闭**：点击关闭或切换到其他渠道时，执行 `tailscale funnel --https=443 off`（确保关闭公网暴露）。
- **未安装 / 未登录引导**：未检测到 `tailscale.exe` 时面板展示官方下载链接与「安装并登录后点刷新」按钮，不做越权静默安装。

### 4. 托盘宿主冷启动弹面板与 `--minimized`

- **命令行参数**：**托盘宿主**支持 `--minimized` 标志。未带 `--minimized` 的冷启动在拉起协议层后，后台轮询待**面板**就绪（超时上限约 15 秒）自动调用既有 `open_panel_url` 打开一次浏览器；携带 `--minimized` 时跳过自动打开浏览器。
- **开机自启快捷方式**：托盘右键勾选「开机自启」写入启动文件夹的 `nexus-mcp.lnk` 时，为快捷方式参数写入 `--minimized`（同时兼容检查已有无参 `.lnk` 的状态，并在重新勾选时刷新参数）。
- **单实例行为不变**：托盘已在运行时再次双击 `nexus-mcp.exe`，仍按现有逻辑直接打开浏览器**面板**并退出副进程。

### 5. NSIS 安装/卸载收尾

- **优雅退出优先**：覆盖安装与卸载前，先通过轻量脚本或命令行读取安装目录 `.tray-control.json` 向 `127.0.0.1:<port>/quit` 带 `X-Tray-Token` 发送优雅退出请求并短暂等待退出；若控制文件不存在或超时未退，再回退执行既有 `taskkill /F` 清理 `nexus-mcp.exe` / `nexus-server.exe` / `nexus-executor.exe`。
- **卸载清理边界**：卸载时除现有程序文件与桌面/开始菜单快捷方式外，额外删除启动文件夹中的 `nexus-mcp.lnk`、安装目录下的 `.tray-control.json`、`nexus-mcp.exe.prev`、`nexus-server.exe.prev`、`nexus-executor.exe.prev` 与 `nexus-mcp.exe.old`；继续严格保留 `config.json`、`oauth-store.json`、`sessions-store.json` 与 `workspace/`。

### 6. 本地一键 Release 脚本与 `README.md` 重写

- **`scripts/release.mjs`（`npm run release`）**：
  - 参数：`npm run release [-- <semver>] [--publish] [--skip-check]`（其中 `--skip-check` 仅用于测试隔离，默认必跑全量检查）。
  - 流程：检查版本格式 → 若传入 `<semver>`，同步更新 `package.json`、`crates/executor/Cargo.toml`、`crates/tray/Cargo.toml`（核对版本号单一事实来源） → 运行 `npm run check` → 运行 `npm run package` 与 `npm run package:smoke` → 计算 `release/` 下安装包与 zip 的 SHA-256 写入 `release/SHA256SUMS.txt` → 检测 `gh` CLI 及登录状态：可用时执行 `gh release create v<version> <setup> <zip> <SHA256SUMS.txt> --title ... --notes ...`（默认带 `--draft`，传 `--publish` 去掉 `--draft`）；不可用时明确打印本地产物路径与手动上传指引并以成功状态结束。
  - **红线遵守**：全程本地运行，不生成任何 `.github/workflows/` 文件，不自动 `git push` 未经确认的提交（若工作区存在未提交改动或 tag 推送前置条件不满足，给出清晰提示而非静默强推）。
- **`README.md` 与 `使用说明.txt` 更新**：
  - `README.md` 顶部改为「下载安装 → 双击启动（自动开面板）→ 选一种公网接入（1 分钟临时隧道 / 免域名 Tailscale Funnel / 自有域名命名隧道）连上 Gemini 或 ChatGPT」，附 GitHub Releases 直达链接与 Windows SmartScreen 首次放行说明；
  - 彻底移除过时的 `启动.cmd`、手动 `nexus-mcp.vbs`、旧双 exe 描述与手杀 8787 升级步骤，将开发与本地发布命令移至后半段。

## Testing Decisions

好测试只验证**外部可观察行为**（HTTP 响应、配置落盘、进程启停状态、CLI 输出与生成文件），不耦合内部私有函数或实现细节，所有测试不得依赖宿主机真实网络、真实 `cloudflared`、真实 Tailscale 账号或真实 GitHub 仓库。

按已确认的 **3 个公开测试缝隙**验收：

1. **面板 HTTP API 缝隙**（复用 `tests/panel.test.ts`、`tests/tunnel.test.ts` 与 `tests/support/server.ts` 先例）
   - 启动真实 `dist/index.js`，注入 stub `cloudflared`、本地 HTTP 模拟下载服务器（覆盖成功校验与 SHA-256 不匹配拒绝）以及 stub `tailscale` CLI；
   - 验证四态单通道互斥切换（开启新渠道前旧渠道被真实停止）、**临时隧道**按需下载与 `trycloudflare.com` URL 解析回填、`Tailscale Funnel` 检测/一键启停/首次授权 URL 捕获、以及老用户既有**命名隧道**配置在存在已登录 `tailscale` 时不被自动切换或覆盖 `tunnelUrl`。
2. **托盘宿主进程缝隙**（复用 `crates/tray/tests/lifecycle.rs` 先例）
   - 启动真实 `nexus-mcp.exe`，配合 `NEXUS_TRAY_OPEN_URL_LOG` 桩与独立临时端口：
     - 不带 `--minimized` 启动，断言面板就绪后日志记录了精确的面板 URL；
     - 带 `--minimized` 启动，断言不触发打开浏览器；
     - 校验开机自启 `.lnk` 构造逻辑写入 `--minimized` 参数。
3. **打包、NSIS 与本地发布脚本缝隙**（复用 `tests/packaging.test.ts`、`npm run package:smoke` 并新增 `tests/release.test.ts`）
   - 校验 `nexus-mcp.nsi` 含优雅退出优先逻辑、卸载清理 `.lnk`/`.prev`/`.tray-control.json` 且不删 `config.json`/`oauth-store.json`/`workspace`；
   - 在临时隔离目录中运行 `scripts/release.mjs`（注入 stub `gh` 与模拟产物），验证版本号跨 `package.json` 与两个 `Cargo.toml` 同步、`SHA256SUMS.txt` 格式与真实哈希一致、默认传 `--draft` 与显式 `--publish` 透传、以及 `gh` 缺失时的降级输出。

## Out of Scope

- 不在安装包内嵌 `cloudflared.exe`、`tailscale` 安装包或 Git for Windows（保持安装包精简）。
- 不内置托管 `ngrok` 或 Microsoft Dev Tunnels。
- 不启用 GitHub Actions 或任何云端 CI/CD 自动构建工作流（ADR-0003）。
- 不做应用内自动热更新下载器或 Winget / Scoop 包管理器提交（留待后续独立演进）。
- 不做代码签名证书采购与签名流水线（在文档中说明 Windows SmartScreen 首次放行方式）。

## Further Notes

- **pinned `cloudflared` 版本**：实现按需下载时需核实最新稳定版 `cloudflared` Windows amd64 发布地址与官方 SHA-256（参考 2026.10.2 及之后版本），并将其固定在代码常量中，禁止无校验下载。
- **未签名的 SmartScreen 提示**：本阶段发出的 `setup.exe` 仍无代码签名，首次在他人电脑运行会弹出 Windows Defender SmartScreen，「更多信息 → 仍要运行」需在 `README.md` 首页显眼位置写明。
- **相关领域文档**：`GLOSSARY.md`（**隧道**、**临时隧道**、**命名隧道**、**托盘宿主**、**热切换**）、`docs/adr/0003-no-github-actions.md`、`docs/adr/0005-sea-plus-nsis-packaging.md`、`docs/adr/0008-rust-tray-host-and-tunnel-lifecycle.md`、`docs/adr/0009-isolated-runtime-and-rollback-hotswap.md`、`docs/adr/0010-zero-config-onboarding-and-tunnel-tiers.md`。
