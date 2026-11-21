# 01: HTTP 传输与会话隔离

**What to build:** 把服务从只能 stdio 启动扩展为可以走 streamable HTTP。配置里选 http 时，服务监听配置端口，云端 AI 或本地客户端用 `http://127.0.0.1:<port>/mcp` 就能连上并看到全部 8 个工具；令牌错误被拒；两个客户端同时连接时各自初始化、互不串话。

**Blocked by:** None（可以立即开始）

**Status:** done

- [x] 配置 `transport` 为 `http` 时服务监听配置的端口，`transport` 为 `stdio` 时行为不变
- [x] 官方 MCP 客户端能通过 HTTP 端点连接、初始化、列出 8 个工具
- [x] 缺失或错误的 Bearer 令牌返回 401，响应体说明缺什么
- [x] 正确令牌放行，且令牌不出现在任何日志里
- [x] 令牌为空时只接受 loopback 来源的连接
- [x] 两个客户端各自初始化后，`mcp-session-id` 不同，工具调用结果互不影响
- [x] 会话断开后服务端释放该会话关联的资源，不随重连次数增长
- [x] 现有 4 条测试继续通过，新增一条走 HTTP 的端到端用例

## Comments

实现：`src/server.ts`（每会话一个 server 实例）、`src/http.ts`（监听、鉴权、会话表与释放）、`src/index.ts`（按 transport 分流）。

测试：`tests/http.test.ts`，9 条用例全部走官方 `StreamableHTTPClientTransport`；`npm run check` 通过（build + 13 测试 + smoke）。
