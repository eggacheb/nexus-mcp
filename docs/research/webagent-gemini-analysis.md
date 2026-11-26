# WebAgent 2.0（`cankaoproject/webagent`）Gemini 适配机制调研

调研日期：2026-11-26（严格只读分析 `cankaoproject/webagent`，未修改或构建）

## 核心结论

`cankaoproject/webagent` **并不是**「在 Gemini 网页版上自动点击官方自定义 MCP 的『允许』确认弹窗」的工具。它走的是**完全另一条技术路线——基于文本协议的浏览器 DOM 闭环**：

1. **绕开官方自定义 MCP**：通过 Chrome Manifest V3 扩展向 `gemini.google.com` 注入协议提示词，让模型在普通对话回复里输出 ```` ```nexus ```` 代码块表达工具调用。
2. **Quill 编辑器绑定与多行指令自愈**：扩展的 `content.js` 监听 Gemini 回复 DOM 稳定后，解析 ```` ```nexus ```` 代码块，由扩展自己请求本机回环的 Nexus 后端执行，再把结果通过 Quill 富文本编辑器（`execCommand` / 粘贴事件 + 完整键盘事件）自动填回输入框并点击发送，形成自主循环执行。
3. **内置自有确认开关**：因为不经过 Gemini 官方自定义 MCP 协议，所以**天然不会触发 Gemini 的 Action Safety Agent 弹窗**；是否人工审核完全由扩展自己的「自动执行 / 手动确认模式」开关控制。

## 两种路线对比

| 维度 | WebAgent 文本协议路线 | 官方自定义 MCP（当前 `nexus-mcp`） |
| --- | --- | --- |
| **是否触发 Gemini 官方弹窗** | 否（不走官方连接器） | 写/执行类工具（`bash`/`git`/`job_start`）受 Action Safety Agent 硬性拦截 |
| **工具调用原生度** | 文本块解析，占上下文且依赖页面 DOM（Quill 改版需跟修） | 原生 Function Calling，零提示词开销、不依赖网页 DOM |
| **适用平台** | DeepSeek / ChatGPT / Gemini / Qwen 等 10+ 网页端 | 支持自定义 MCP 的客户端（Gemini Web / Antigravity / Gemini CLI / ChatGPT） |

## 关于「单独提取成自动点允许的浏览器扩展」的评估

- **技术可行性**：如果目标只是给当前的官方自定义 MCP 自动点 Gemini 页面上的「允许」按钮，不需要搬运 `webagent` 的 7000+ 行 Quill/文本协议代码——一个极简的 Chrome MV3 扩展（~80 行 `content.js` + `MutationObserver`）就能匹配包含 `Nexus Mcp` 的确认弹窗并自动点击「允许」。
- **安全边界（需知晓）**：
  - 自动点击「允许」等同于关闭 Gemini 侧的 Action Safety Agent 防提示注入闸门；若模型读取了含恶意指令的网页或文件并被诱导执行 `bash`，将直接放行到本地执行层。
  - 若要启用此类自动点击扩展，**务必**配合 `nexus-mcp` 本身的硬护栏：保持**沙箱根**收紧、保留**内置危险表**，并优先开启 `commandPolicy.allow` 白名单，且仅对特定连接器名称（如 `Nexus Mcp`）生效，绝不全局无差别点击所有弹窗。
- **更稳的官方替代**：若只是本地开发无人值守，直接使用支持确定性权限白名单的 **Google Antigravity CLI (`agy`) / IDE** 或 **Gemini CLI**，无需依赖脆弱的网页 DOM 自动点击。
