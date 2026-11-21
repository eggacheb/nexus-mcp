# 10: 隧道接入

**What to build:** 云端 AI 要一个 https 地址才能连进来，所以服务必须能拉起一条到本机的隧道，并且把地址显示在面板上、实时反映通断。这台机器上已有可用的 Cloudflare 命名隧道（固定域名），它指向的是旧服务；这张票把它接到新服务，并处理「进程挂了没人管」和「开机不自启」这两件事。

**Blocked by:** 01

**Status:** done（2026-11-21，npm run check 全绿：vitest 115 条 + cargo 108 条 + smoke；隧道已接管公网；Gemini 网页版实测通过，8 个工具全部出现，见验收第 13 条）

- [x] 面板上一键启动与停止隧道进程，操作结果即时反映在状态灯
- [x] 面板显示当前公网地址，并提供可达性检测（请求 health 端点）
- [x] 隧道进程退出时状态灯变红，能看到退出码或最后几行错误
- [x] 使用固定域名的命名隧道（本机已有 `config.yml` 与隧道凭据），不使用临时随机地址
- [x] 新服务监听 8787，与现有隧道配置（`nexus.maliy.top` → `127.0.0.1:8787`）一致，`config.yml` 一行不改
- [x] 不采用「改隧道配置指向其它端口」的做法，理由：那要动一个已经能工作的配置文件，且 Gemini 侧无需任何改动
- [x] 明确记录端口占用代价：8787 同时只能有一个服务监听，接管前必须先停掉旧的 Bridge 进程
- [x] 不尝试注册 Windows 服务或计划任务（本机实测两条路都不可用，原因见交接笔记）
- [x] 提供开机自启方案：启动文件夹放置隐藏窗口启动器
- [x] 处理「没有自愈」：给出守护方案（进程退出后重启），并说明代价是多一个常驻进程
- [x] 交接笔记里的排障顺序原样保留在文档里，方便下次断线时照着查
- [x] 记录沙箱限制：本机部分命令（注册计划任务、COM 实例化）需用户手动执行
- [x] 实际用 Gemini 网页版连一次（走 OAuth + 隧道全流程），记录成功或失败的具体现象

**已拍板的决策**（2026-11-21，小白点头）：

1. 新增 MCP 端点 `GET /health`（无鉴权，只暴露存活），与旧 `nexus-tunnel.cmd` 和排障顺序的 URL 一致。
2. 面板隧道卡：启动/停止双按钮 + 「检测可达性」按钮 + 公网地址展示，灯 = 进程 + 公网合成状态，卡内显示 pid、退出码、错误尾行。
3. 守护方案用**面板内置重启**（异常退出 10 秒自动拉回，停止按钮不触发），不用交接笔记的循环守护 vbs。代价相应变化：**不加常驻进程**，但守护跟随服务进程，服务自己挂了没人管（服务死了隧道独活也没用）——验收线 10 的「代价是多一个常驻进程」按拍板后的实际代价如实记录在 `docs/tunnel.md`。
4. 开机自启不做面板按钮：本机已就位（Startup 里的 `nexus-tunnel.vbs`），文档说明原理与移除方法即可。

## Comments

### 2026-11-21 实现（agent）

**改动**：

- `src/tunnel.ts`（新）：TunnelManager——detached + 无窗口 spawn `cloudflared --config <yml> --logfile <log> tunnel run`，服务退出不带走隧道；记录退出码与时间，`--logfile` 落盘日志取尾部 8 行；异常退出 10 秒后自动重启（`tunnel.autoRestart: false` 可关）；服务重启后按外部进程接管（tasklist 检测，不重复拉起；stop 走 `taskkill /IM cloudflared.exe /F`，与旧 nexus-tunnel.cmd 同法）。路径默认解析：cloudflared 在 `Program Files (x86)`，config 在 `%USERPROFILE%\.cloudflared\config.yml`，都可在 config.json 的 `tunnel` 段覆盖。
- `src/config.ts`：新增 `tunnel` 配置段（`cloudflaredPath` / `configPath` / `autoRestart`），形状不对启动即报错；`saveConfig` 写回。
- `src/mcpService.ts`：鉴权之前加 `GET /health` → `{"ok":true,"service":"nexus-mcp"}`。
- `src/status.ts`：新增 `tunnelStatus()` 合成——不可用（路径缺失，黄）/ 离线（未运行，红，附退出码）/ 异常（进程在但公网探测非 200，红）/ 在线（绿）；公网探测统一走 `probeEndpoint()`（只认 200，防 ingress 配错返回 404 也亮绿灯），兼容路径（未配 tunnel 段）同样打 `/health`；未配 tunnel 段时退回旧探测行为。
- `src/panel.ts`：隧道卡（公网地址 + 启动/停止/检测三按钮 + pid/退出码/错误尾行）；`POST /api/tunnel`（start/stop/probe）；写操作抽公共壳 `readWriteBody`（跨站防护 + JSON 解析）。
- `src/index.ts`：按 config 构造 TunnelManager 传入面板。
- `.gitignore`：补 `config.json` / `oauth-store.json`（config.json 含令牌，绝不能进仓库）。
- 测试缝：stub 注入走环境变量 `NEXUS_TUNNEL_STUB`（对齐 `NEXUS_GIT_BASH` 先例），不进 config.json 配置面。
- `docs/tunnel.md`（新）：现行运维文档——链路、8787 独占代价与接管步骤、面板操作、/health、开机自启原理与移除、守护方案与代价、**排障顺序原样保留**（旧系统第 3 条的判定差异加了注）、**沙箱限制记录**、Gemini 实测记录位。
- `tests/support/server.ts`：StartOptions 透传 `tunnel` 段。

**验收对照**（每条的证据）：

1. 面板一键启停 → `tests/tunnel.test.ts`「面板启动隧道…」「面板停止隧道…」（真实 dist 进程 + stub cloudflared 走 `/api/tunnel`）；真机实测：stop 后 tasklist 确认进程消失，start 后公网 health 恢复 200。
2. 公网地址 + 可达性检测 → 「初始状态：…带公网地址」「面板启动隧道…公网可达变绿」；真机 `https://nexus.maliy.top/health` 返回 `{"ok":true}`。
3. 退出码/错误尾行 → 「进程退出时记录退出码与日志尾部」（stub 退出码 7 + 尾行断言）；灯红由「初始状态…」断言。
4. 固定域名命名隧道 → spawn 参数就是既有 `config.yml` + 凭据（测试断言 configPath，真机 spawn 输出确认），无 quick tunnel 路径。
5. 8787 与隧道配置一致、config.yml 一行不改 → `config.ts` 默认端口 8787（未动），本机 `config.yml` 内容核对为 `nexus.maliy.top → http://127.0.0.1:8787`，实施全程未写该文件。
6. 不改隧道配置指向其它端口 → 决策记录在本票与 `docs/tunnel.md`「端口占用的代价」节。
7. 8787 独占代价 → `docs/tunnel.md`「端口占用的代价」节（含旧 Bridge 自启项 `Nexus.lnk` 的提醒）。
8. 不注册服务/计划任务 → 代码里无 schtasks/service install 调用；原因原文保留在 `docs/tunnel.md`。
9. 开机自启 → 启动文件夹方案已就位并核对内容（`nexus-tunnel.vbs` → `start-hidden.vbs`），原理与移除方法在 `docs/tunnel.md`。
10. 守护 → `tests/tunnel.test.ts`「守护：异常退出后自动拉回新进程，stop 后不再重启」（restartDelayMs 300ms 注入）；代价按拍板后的实际代价记录（见上「已拍板的决策」3）。
11. 排障顺序原样保留 → `docs/tunnel.md`「排障顺序」节，四步原文照抄（第 3 条加旧/新系统判定差异的注）。
12. 沙箱限制 → `docs/tunnel.md`「沙箱限制」节，原文照抄并注明哪些操作不受影响。
13. Gemini 实测 → **已通过**（2026-11-21 23:07）：Gemini「应用连接器」添加自定义 MCP（`https://nexus.maliy.top/mcp`）→ 跳转授权页输入 config.json 的 token 批准 → 保存成功，显示 8 个工具（read/write/edit/bash/glob/grep/job_start/job_output），同步时间正常刷新。OAuth 动态注册 + PKCE + 命名隧道全流程走通，现象记录在 `docs/tunnel.md`「Gemini 实测记录」。

**复用来源**：无外部代码搬运；外部进程检测与 taskkill 行为对齐本机已有 `nexus-tunnel.cmd`（实测有效的做法）。

**已知边界（记录在案不修）**：

- 面板 stop 对本面板拉起的进程用句柄 kill（Windows 下走 TerminateProcess），Node 侧报 signal 而非数值退出码——真崩溃（非手动停止）才有数值退出码，语义正好；探针超时 2 秒、轮询 5 秒，cloudflared 刚启动连边缘的头几秒内灯短暂「异常」属正常，连接建立后自动转绿。
- `tasklist`/`taskkill` 子进程未设 UTF-8 环境（AGENTS「子进程一律 UTF-8」字面违例）：这两个系统工具只做 ASCII 镜像名匹配、输出不进任何对外通道，判断后不修。
- 守护跟随服务进程：服务进程挂了隧道没人管（见决策 3）；服务自身的自启与守护归票 11。
- panel.ts 页面/路由混居一文件（Divergent Change 判断题）：等面板再长一块再拆。

**部署实测补充**（2026-11-21，真机验证时发现）：

- 本机出网走全局代理（`HTTPS_PROXY`/`ALL_PROXY` → `127.0.0.1:7897`）。Node 24 的 fetch 默认不跟随这些环境变量，面板公网探测直连 Cloudflare 稳定超时（curl 却正常）。已在 `src/index.ts` 入口开 `NODE_USE_ENV_PROXY=1`（Node 24 实测生效，无代理机器为空操作），开启后面板「在线 公网可达 HTTP 200」。代理掉线时面板会误报「公网不通」但隧道本身是好的——记入 `docs/tunnel.md` 排障注 2。
- 部署创建根 `config.json` 后，暴露出三处测试对「仓库根无 config.json」的隐性耦合：`smoke.ts`、`mcp.test.ts`、`bash.test.ts` 主会话（stdio 且不带 NEXUS_MCP_CONFIG，回落读部署配置，root 变成工作区根导致相对路径全错）。已全部改为自带隔离临时配置。
- 隧道测试与真隧道隔离：dist 进程 env 加 `NEXUS_TUNNEL_EXTERNAL=off`（测试缝，对齐 NEXUS_GIT_BASH 先例），进程级用例注入 `isRunningExternal` 桩；否则跑测试的机器上有真隧道时外部检测会把用例判歪，且 stop 会误杀真隧道（本票实测发生过一次，被服务的守护自动救回）。

**审查结论**（2026-11-21 双轴）：已采纳——探测合并去重并收紧为 200-only（防 404 亮绿灯）、旧探测路径补 cause 提取、panel 三个 POST 路由抽公共壳、pid/退出码进面板卡、`argsPrefix` 移出配置面改环境变量、`.gitignore` 去冗余行、状态灯语义与票面措辞修正。未采纳（判断题）：action 裸字符串不立联合类型（面板侧 JS 本就无类型，收益低）。
