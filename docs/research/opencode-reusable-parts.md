# opencode 可复用组件调研

调研对象：`cankaoproject/opencode`（monorepo，Bun + TypeScript + Effect，MIT License，`LICENSE:1-2`，无 NOTICE 要求，比 codex 的 Apache-2.0+NOTICE 干净）。路径均相对于该目录。**只读参考，不要在该目录里执行构建或安装命令。**

来源：后台子代理全仓调研（2026-11-21）。与 `codex-reusable-parts.md` 对照阅读：两者互补，codex 侧已有结论不受影响。

---

## 结论摘要

1. **最重要的纠偏：`packages/patchmark` 不是 patch 应用器**——它是流式 Markdown 解析/渲染库（`packages/patchmark/src/index.ts:1-4` 导出全是 block/inline/heal/html 渲染 API，被 `packages/session-ui/src/components/markdown-stream.ts` 用于渲染 AI 回复流）。与 codex apply-patch 赛道无关。opencode 真正的「edit 模糊匹配算法」在 **`packages/core/src/tool/plugin/edit.ts`**，质量很高，是本次调研的第一移植候选。
2. opencode 的 MCP 是**客户端**（`packages/core/src/mcp/index.ts:7` 依赖 `@modelcontextprotocol/client`），server 包是纯 HTTP API 服务，**没有「把自己工具挂成 MCP server」的现成实现**。nexus-mcp 自己的 MCP 层无现成可抄。
3. `packages/process-daemon` = **opencode-pty v0.6.0**（MIT，`Cargo.toml:1-9`）：持久 PTY/管道进程守护进程。对 nexus-mcp 赛道**部分重合**：Windows Job Object 进程树硬杀 + 命名管道派生 + 输出文件正是 Rust 执行器需要的参考；daemon/handoff/ghostty 终端仿真体量大、不碰。
4. Effect 框架渗透全仓，**直接搬包不可行**，只能搬「单文件 + 零/轻依赖」的算法文件。MIT 无归属负担。

---

## 总表

| 候选 | 位置 | 依赖重量 | Windows 线索 | 建议 |
|---|---|---|---|---|
| edit 模糊匹配算法 | `core/src/tool/plugin/edit.ts` | 极轻（单文件，仅 effect 包装） | CRLF 双向处理完备 | **直接搬**（本次最佳候选） |
| read 分页读取器 | `core/src/tool/read-filesystem.ts` | 轻（effect + util/text-boundary） | BOM/utf-8 处理完备 | **抽出来改** |
| rg 二进制发现+下载 | `core/src/ripgrep/binary.ts` | 轻 | System32 bsdtar 解 zip | **直接搬** |
| ripgrep 调用适配层 | `core/src/ripgrep.ts` | 轻 | 路径归一化 | **抄 args 集/直接搬** |
| 进程树终止 + 输出泵 | `util/src/cross-spawn-spawner.ts:440-497` | 轻 | `taskkill /pid X /T /F`(:474) | **抄思路** |
| 文本边界裁剪 | `util/src/text-boundary.ts`（37 行零依赖） | 极轻 | — | **直接搬** |
| timeout→后台任务模型 | `core/src/tool/plugin/shell.ts` | 重（Job/Session/Effect） | — | **只抄模型** |
| Windows Job Object 树杀 | `process-daemon/src/service/pipe/windows.rs` | Rust 单文件 | JOB_OBJECT_KILL_ON_JOB_CLOSE | **给 Rust 执行器直接抄** |
| patchmark | `packages/patchmark/` | 零运行时依赖 | — | **放弃**（用途无关） |
| job.ts 持久化后台任务 | `core/src/job.ts` | 重（drizzle/DB/session） | — | **放弃** |
| core 整体 / server / protocol / schema | — | 极重（Effect+DB+HTTP API） | — | **放弃** |

---

## 1. packages/core 工具实现（`src/tool/plugin/`）

工具插件架构：`src/tool.ts` 是 Location 级注册表，built-in 在 `tool/plugin/`，权限走 `Permission.assert`（`src/tool/AGENTS.md:1-13`）。这层架构全 Effect 化，**不搬**；搬的是各文件内的算法。

### read（`tool/plugin/read.ts` + `tool/read-filesystem.ts`）
- 行号：1-based 前缀 `${start + index}: ${line}`（`read.ts:391`），与我们的输出格式一致。
- offset/limit：默认/上限 2000 行、50KB 字节（`read-filesystem.ts:12-13`）；单行截断 2000 字符加 `... (line truncated to 2000 chars)`（`:17,20,342-343`）；截断时输出 `[Output truncated. Continue reading with offset: N]`（`read.ts:392`）。
- **负 offset = 尾读**：offset 超出文件末尾时返回最后 N 行（默认 100，`read-filesystem.ts:16,293-311`），好特性，我们的 read 可以考虑跟进。
- 非 UTF-8/二进制：NUL 字节扫描判二进制（`:147,263-266,314`）；图片/PDF 走 media 检测并附 base64（`read.ts:357-366`），媒体上限 20MB（`:14`）。
- 分页实现是「256KB chunk 流式扫描 + checkpoint 记录行号↔字节偏移」的 seek 读取（`read-filesystem.ts:174-322`），内存友好，值得整段改编。
- 移植代价：`read()` 函数只依赖自有的 `Files` 接口 + `TextBoundary` + Effect 包装，把 Effect 换成 async 约 340 行，**改编代价低**。

### write（`tool/plugin/write.ts`）
- 极薄的 leaf（73 行），实体逻辑在 `file-write.ts`（保留 BOM 重写 `:83`）+ Formatter 钩子。BOM 保留值得抄（`@opencode/util/bom`），其余无新意。

### edit（`tool/plugin/edit.ts`，371 行）★ 第一候选
- 三级匹配降级：精确 → **Unicode 归一化**（弯引号/弯破折号/各类空格归一，`:45-50`）→ **行级 trailing-whitespace 匹配**（`:62-98`），与 codex 的 fuzzy 分层思路同源但实现不同。
- **CRLF 双向处理**：在 LF 视图上匹配再映射回原偏移（`matchView :166-186`）；替换行的行尾风格按「替换后保留原行的行尾」用 LCS 对齐分配（`withRegionEndings :114-160` + `alignLines :129-160`）。混合行尾文件不会被污染——这是 edit 工具最容易漏的点。
- **miss hint**：匹配失败时用「忽略全部空白的行投票定位最近区域」输出 12 行带行号提示（`:197-239`），还会检测「newString 已在文件中=编辑已应用过」（`:200-201`）。
- 唯一性校验、replaceAll、权限预检、文件锁（`fileMutation.withLock`，`:365`）。
- 移植代价：算法部分（`findOccurrences`/`findLineOccurrences`/`matchView`/`withRegionEndings`/`missHint`）几乎是纯字符串函数，**剥掉 Effect 壳即可直接搬**。
- 与 codex apply-patch 的关系：互补——codex 是 unified-diff hunk 解析+seek_sequence 模糊定位；opencode 是 oldString/newString 三级降级+CRLF 保真。建议 edit 工具用 opencode 算法做主路径，apply-patch 做 patch 文本支持。

### bash/shell（`tool/plugin/shell.ts` + `src/shell.ts`）
- 超时模型：默认前台 120s、CodeMode 10min（`:29-30`）；**前台超时不杀，而是转后台**并通知模型（`:471-472` 注释、`backgroundResult :151-159`），后台完成时向会话注入合成消息（`notify :162-194`）。job_output 需求可直接对齐这套语义。
- 输出缓冲：合并 stdout/stderr 写后备文件，返回有界 tail + 全量文件路径（`src/tool/AGENTS.md:61`；`shell.ts` 服务 `EXITED_LIMIT=25`、保留 7 天，`src/shell.ts:48-49`）。
- 进程树终止：Windows `taskkill /pid X /T /F`（`util/src/cross-spawn-spawner.ts:472-478`），Unix `process.kill(-pid)` 进程组（`:481-487`）；**Windows 脱离子进程挂着 stdio 的坑**：退出后 1 秒共享 deadline 关泵、之后 drain 丢弃（`:440-449` 注释点名 dotnet build/MSBuild 场景）。
- 服务层（`src/shell.ts`）支持 daemon 化运行、服务器重启后接管（`reattach`、handoff），依赖 Session/Bus/Environment，重，不搬。

### glob/grep（`tool/plugin/glob.ts`、`grep.ts` + `src/ripgrep.ts` + `ripgrep/binary.ts`）
- **都调 ripgrep 二进制**（不是 JS 实现）：glob = `rg --no-config --files --glob=<pattern> --glob=!**/.git/**`（`ripgrep.ts:187-197`）；grep = `rg --no-config --json --no-messages --fixed-strings? --ignore-case?`（`:240-252`），逐行解析 JSON，`Stream.take(limit+1)` 实现截断检测（`:148-151`），非 UTF-8 行走 base64 `bytes` 解码（`:24-46`），单行 2000 字符、子匹配 100 个上限（`:20-22`）。
- rg 二进制发现（`ripgrep/binary.ts`）：先 `which rg`（:121）→ 全局 bin 缓存（:124）→ 都没有就下载 pinned 15.1.0 官方 release 并 **SHA-256 校验**（`:15-54,155-159`）；Windows 解 zip 用 `System32\tar.exe`（bsdtar），注释解释了为什么不能用 PATH 上的 tar（GNU tar 读不了 zip）和 ANSI 代码页对含中文用户名路径的坑（`:91-100`）。这段 Windows 证据非常值得抄。
- 工具层截断输出文案与 `toModelContent` 聚合格式（`glob.ts:36-44`、`grep.ts:45-62`）可参考。

### 后台任务（`src/job.ts`）
- 通用 Job 注册表：DB 持久化（drizzle）、后台化、通知 ID、恢复元数据、取消传播（`job.ts:22-25,36-45`）。**依赖 Database/Session/Bus，重，放弃**；只抄「后台任务完成时向会话注入通知」+「recovery 元数据让重启后可接管」的模型。

## 2. packages/patchmark

- 是什么：**流式 Markdown 块级解析器/HTML 渲染器**（`src/index.ts:1-16`），核心能力是「半行 block 开头标记回持」（`splitPendingMarker`，`src/stream.ts:20-49`）和流尾 inline 修复（heal），用于 session-ui 渲染模型回复流。
- 依赖：零运行时依赖（`package.json:16-24` 全是 devDeps），MIT，`private: true`。
- 结论：**放弃**。名字里的 "patch" 是「给流式 Markdown 补丁」，不是代码补丁。计划中「从 codex apply-patch 抄模糊匹配」不受影响；opencode 侧的对位物是 `core/src/tool/plugin/edit.ts`。

## 3. packages/process-daemon（opencode-pty）

- 是什么（`README.md:1-25`、`SPEC.md`）：持久 PTY + 管道进程守护进程，`portable-pty` 持有子进程、libghostty-vt 维护终端状态（`Cargo.toml:9` `links = "ghostty-vt"`）；本地传输 UDS/Windows named pipe + token 认证 + 注册文件；owner 连接 + `prepare_handoff` 票据（120s）实现服务器重启后命令接管（`README.md:27-39`）。
- 协议形态：**不是 stdio 单行 JSON**，是认证信封 JSON（token+request）+ 8MB 上限帧（`src/protocol.rs:12,20,30-34`），`CreatePipe` op 支持非 PTY 进程 + `output_path` 输出文件（`:55-63`）。
- 重合度：**kill/派生/输出三块直接重合，daemon/终端仿真不重合**。39 个 .rs 里 `src/ghostty/` + daemon/ownership/transport 约一半体量属于不需要的部分。
- 值得抄的精确定位（Windows）：
  - `src/service/pipe/windows.rs:41-45`：`CreateJobObjectW + JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`；
  - `:700-746`：建 job、set limits、`AssignProcessToJobObject`；
  - `:198-200`：停止时 `TerminateJobObject(job)`，无 job 退化 `TerminateProcess`；`:754-757` 失败兜底再 Terminate；
  - `:7-9` 注释：设计原则「不用 console 信号，一切 signal 都是树级硬杀」——与 nexus-mcp Windows 优先同思路。
- 依赖（`Cargo.toml:11-40`）：anyhow/base64/crossbeam/fs2/portable-pty/serde/shell-words + windows-sys；portable-pty 是最大的额外依赖。只抄 `pipe/windows.rs` 单文件不需要 portable-pty。
- 移植代价：**ghostty/daemon/handoff 放弃**；`service/pipe/windows.rs`（Job Object + CreatePipe 派生 + 管道服务）作为 Rust→Rust 参考直接对照实现，代价低收益高。

## 4. util / protocol / server

- **util**（`packages/util/package.json`）：包整体重（effect、otel 全家桶、npmcli，`:42-65`），但**单文件零依赖**可摘：`text-boundary.ts`（37 行，UTF-16/UTF-8 边界裁剪，`head/tail/utf8Tail`，`:11-33`）——nexus-mcp 已从 codex 搬了 head-tail-buffer，此文件是 TS 侧对位物，按需取一；`bom.ts`、`execute-output.ts`、`glob.ts` 同理可摘文件不摘包。
- **路径沙箱/权限**：`core/src/file-access.ts`——词法解析 `resolvePath`（`~` 展开 + `FSUtil.windowsPath` 归一化，`:113-120`）、`authorizeExternal` 外部目录审批边界（`:38-44,97-101`）、权限 resource/save 规则（`:57-78`）。设计思路（「lexical resolve 先行、磁盘不碰、外部目录单独审批」）值得抄，实现绑死 Effect+Permission 服务，**只抄思路**。
- **protocol**：HTTP API 错误/类型包，无独立价值，放弃。
- **server**（`packages/server/src/`）：effect/http-api 的 REST 服务（`handlers/mcp.ts:19-90` 是「管理外部 MCP server 的增删连断 + PTY 票据」的 handler，不是把工具挂成 MCP 的 server）。**没有现成 MCP server 挂载实现**。放弃。

## 5. 「不要碰」清单

| 部分 | 理由 |
|---|---|
| `packages/core` 整体 | Effect 全家桶 + Session/Database/Bus/Environment 耦合，只能摘单文件 |
| `packages/server` + `protocol` + `schema` | HTTP API 体系 + Location/ServiceMap，与本地 MCP server 赛道不同 |
| `packages/patchmark` | 用途无关（Markdown 渲染），名字有迷惑性 |
| `core/src/job.ts` 持久化任务 | drizzle/DB/session 依赖链，重 |
| `core/src/mcp/*` | MCP **客户端**，非 server |
| `process-daemon` 的 daemon/ghostty/transport/ownership | 守护进程+终端仿真，体量大且赛道不合；只摘 `service/pipe/windows.rs` |
| `core/src/environment`/`machine` | 远程机器/多环境体系，nexus-mcp 是单机单根 |
| desktop/tui/app/ui/session-ui | 前端壳，无关 |

## 6. 移植优先级建议（按 nexus-mcp 的 8 工具）

1. **edit**：搬 `core/src/tool/plugin/edit.ts` 的三级匹配 + CRLF 保真 + missHint（与 codex apply-patch 互补，前者做 oldString/newString 主路径，后者做 patch 文本）。
2. **read**：改编 `read-filesystem.ts` 的分页/尾读/行截断/二进制判定（约 340 行纯逻辑）。
3. **bash**：抄 `shell.ts` 的「超时转后台 + 通知」模型与 `cross-spawn-spawner.ts` 的树杀/输出泵细节；Rust 执行器侧对照 `process-daemon/src/service/pipe/windows.rs` 的 Job Object 实现。
4. **glob/grep**：照抄 `ripgrep.ts` 的 args 组合与 `ripgrep/binary.ts` 的发现+SHA-256 下载+System32 tar 流程。
5. **job_start/job_output**：只抄「后台任务 + 完成通知 + output 文件 + tail 截断」语义，不抄实现。
6. **util 碎件**：`text-boundary.ts`、`bom.ts` 按需零成本摘取。
