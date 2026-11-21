# 09: OAuth 2.1 授权

**What to build:** Gemini 网页版的「自定义 MCP 服务器」只认 https 加 OAuth，没有填 Bearer 头的地方。这张票让本服务能被当作合规的 OAuth 资源服务器：客户端能发现元数据、动态注册、走 PKCE 拿令牌，令牌能访问 `/mcp`，并且需要本地令牌才能批准授权。

**Blocked by:** 01

**Status:** ready-for-agent

- [ ] 提供资源元数据端点，符合 RFC 9728，指向授权服务器
- [ ] 提供授权服务器元数据端点，符合 RFC 8414
- [ ] 支持动态客户端注册（RFC 7591），接受最多 10 个重定向 URI
- [ ] 授权请求使用 PKCE S256，缺失或错误时拒绝
- [ ] 授权页面要求输入本地 Bridge 令牌才允许批准，错误令牌不放行
- [ ] `/mcp` 接受 OAuth access token；令牌无效时返回 401 并带 `WWW-Authenticate` 指向元数据
- [ ] 支持 refresh token，并做轮换（旧的刷新后失效）
- [ ] 令牌以哈希形式落盘，不以明文保存
- [ ] 实际用 Gemini 网页版连一次，记录成功或失败的具体现象
- [ ] 不影响已有的 Bearer 静态令牌路径（两条路并存）
