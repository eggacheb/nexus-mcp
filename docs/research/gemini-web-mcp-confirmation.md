# Gemini 网页版自定义 MCP 确认弹窗机制与规避调研

调研日期：2026-11-26

## 结论速览

1. **为什么开了「始终允许」仍弹窗**：Gemini 网页版（`gemini.google.com`）在工具执行前有一层独立的 **Action Safety Agent** 实时审查用户意图、会话上下文与具体参数；官方明确规定**自定义 MCP 应用的写/执行类操作（如 `bash`、`job_start`、`git commit/push`）目前强制要求人工确认**，不存在任何网页端设置或服务端绕过开关。
2. **我们能在服务端做的优化**：MCP 规范默认省略 `annotations` 时按 `readOnlyHint: false`、`destructiveHint: true`、`openWorldHint: true` 处理。给纯只读工具（`read`、`glob`、`grep`、`job_output`）显式声明 `readOnlyHint: true, destructiveHint: false, openWorldHint: false`，并在更新后到 `gemini.google.com/devmode` 点击 `Sync schema` 刷新，可最大限度减少只读调用的误弹窗。
3. **想要彻底零弹窗跑 `bash` / `git`**：必须使用具备本地确定性权限引擎的客户端（个人 / AI Pro / AI Ultra 账号使用 **Google Antigravity CLI (`agy`) / IDE** 的 `Auto` 或 `Turbo` 模式与 `mcp(server/*)` / `command(git)` 规则；付费 API Key / Vertex AI / Code Assist 账号使用 **Gemini CLI** 的 `"trust": true`）。

## 一、Gemini 网页版强制弹窗的 4 类触发条件

即使在设置中把自定义 MCP 连接器设为 **Always allow（始终允许）**，以下四类机制仍会触发人工确认：

1. **自定义 MCP 写操作硬性要求确认**：Google 官方帮助明确说明 *"Currently, Gemini requires manual confirmation for any write actions"*（[Connect & manage custom apps for Gemini Apps](https://support.google.com/gemini/answer/17209137?hl=en)）。
2. **Action Safety Agent 实时风控**：Google 2026-11-17 安全博客披露，即使已授予长期 `Always allow` 权限，独立的 **Action Safety Agent** 仍会在执行外部工具前核对（a）用户原始诉求、（b）会话历史步骤、（c）本次调用的具体参数；对有真实副作用或跨信任边界的高影响动作强制暂停确认（[How Gemini's defense-in-depth approach works](https://blog.google/security/how-geminis-defense-in-depth-approach-works/)）。
3. **内置敏感操作与数据共享保护**：官方任务权限文档明确说明，即便设为 `Always allow`，涉及敏感操作或对外共享敏感信息时内置保护仍会弹窗确认（[Manage your tasks & workflows in Gemini Apps](https://support.google.com/gemini/answer/17094507?hl=en&co=GENIE.Platform%3DAndroid)、[Manage browser & app permissions for tasks in Gemini](https://support.google.com/gemini/answer/18766567?hl=en&co=GENIE.Platform%3DAndroid)）。
4. **MCP Tool Annotations 的悲观默认值**：按 MCP `2025-11-25` 规范与 Google Connected Apps 集成标准，未提供 `annotations` 时客户端默认按 `readOnlyHint: false`、`destructiveHint: true`、`openWorldHint: true` 处理，后两者正是 Google 表面层触发运行时确认卡的核心标志（[MCP connected app integration standards](https://developers.google.com/connected-apps/mcp/server-optimization)、[Tools - MCP Specification 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)、[Tool Annotations as Risk Vocabulary](https://blog.modelcontextprotocol.io/posts/2026-03-16-tool-annotations/)）。

## 二、2026 年 11 月实测已知的 Gemini Web 权限 Bug

- **弹窗内点「始终允许」反致权限重置**：2026-11-16 至 11-22 实测报告指出，在网页设置已设为 `Always allow` 后，若再次出现确认弹窗并点击弹窗里的 `Always allow`，反而会把网页设置重置回 `Always ask`，连原本静默的只读工具也开始弹窗；**临时规避：只在设置页开启，聊天弹窗里只点 `Allow once`**（[Google Help #477912799](https://support.google.com/gemini/thread/477912799/bug-mcp-connectors-always-allow-permission-state-fails-to-persist-and-resets-to-always-ask?hl=en)）。
- **部分账号 `Always allow` 不持久化**：2026-11-24 至 11-25 社区与产品专家确认，部分账号所有工具（含只读）在跨轮/新会话后会退回每次询问，属于 Gemini Web 端待修复缺陷（[Google Help #478943538](https://support.google.com/gemini/thread/478943538/bug-custom-mcp-tool-permissions-do-not-persist-always-allow-prompts-repeatedly-across-sessions?hl=en)、[Google AI Developers Forum #204879](https://discuss.ai.google.dev/t/bug-custom-mcp-tool-permissions-do-not-persist-always-allow-prompts-repeatedly-across-sessions-and-prompts/204879)）。

## 三、服务端与客户端的可行规避方案

### 1. 服务端（`nexus-mcp`）能做且已做的优化
- 为纯只读工具（`read`、`glob`、`grep`、`job_output`）显式声明 `annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }`（已在 `src/tools.ts` 落地）。
- **注意刷新快照**：Google Connected Apps Platform 在注册时快照工具 schema，服务端更新注解后需前往 `gemini.google.com/devmode` 的 `Tool Schemas` 页点击 **Sync schema**（或重新连接应用）才会生效（[Test, debug, and evaluate in Gemini Apps Developer Mode](https://developers.google.com/connected-apps/mcp/dev-mode/usage)）。
- **切勿伪造注解**：把 `bash` / `write` / `edit` 伪标为 `readOnlyHint: true` 既违反安全规范，也绕不过 Action Safety Agent 对参数和上下文的实时审查。

### 2. 需要彻底免弹窗无人值守时的客户端替代方案

| 客户端 | 适用账号（2026-11） | 免弹窗配置方式 | 来源 |
| --- | --- | --- | --- |
| **Google Antigravity CLI (`agy`) / IDE** | 个人免费 / Google One / AI Pro / AI Ultra（2026-06-18 起替代 Gemini CLI） | 支持 `Deny > Ask > Allow` 规则（如 `command(git)`、`mcp(server/*)`）及 `Auto`（Windows v2.26.0+）/ `Turbo` 预设 | [Permissions \| Google Antigravity Docs](https://antigravity.google/docs/permissions/)、[Settings](https://antigravity.google/docs/settings/) |
| **Gemini CLI** | 付费 Gemini API Key / Vertex AI / Code Assist Standard & Enterprise | `settings.json` 中对目标 MCP 服务设 `"trust": true`（或 `gemini mcp add --trust`） | [MCP servers with Gemini CLI](https://geminicli.com/docs/tools/mcp-server/) |
| **Gemini Code Assist Agent Mode（VS Code / JetBrains）** | 支持的 IDE 用户 | 设置 `"geminicodeassist.agentYoloMode": true` 或勾选 Agent `Auto-approve changes` | [Use the Gemini Code Assist agent mode](https://docs.cloud.google.com/gemini/docs/codeassist/use-agentic-chat-pair-programmer) |

## 未确认项
- Google 尚未公开 Gemini Web 内部 Policy Guardian / Action Safety Agent 对具体 `git` 子命令的专有判定规则清单。
