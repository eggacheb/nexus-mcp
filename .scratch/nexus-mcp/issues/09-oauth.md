# 09: OAuth 2.1 授权

**What to build:** Gemini 网页版的「自定义 MCP 服务器」只认 https 加 OAuth，没有填 Bearer 头的地方。这张票让本服务能被当作合规的 OAuth 资源服务器：客户端能发现元数据、动态注册、走 PKCE 拿令牌，令牌能访问 `/mcp`，并且需要本地令牌才能批准授权。

**Blocked by:** 01

**Status:** done（2026-11-21，npm run check 全绿：vitest 107 条 + cargo 108 条 + smoke；双面审查已过，修正项见「审查结论」；Gemini 实测验收归属票 10）

**审查结论**：已采纳并修正——限速标识改 `clientIp()`（仅 loopback 直连时信任 `CF-Connecting-IP`，隧道场景分得出真实来源，外部直连伪造的头不采信）；`code_challenge` 补 RFC 7636 §4.2 形状校验（43-128 个非保留字符，畸形值在授权端点即拒）；`/mcp` 401 的 `WWW-Authenticate` 补 `error="invalid_token"`（RFC 6750）；删 `mcpService` 的 `tokenEquals` 改用 `oauth.ts` 导出的 `safeEqual`（消常量时比较重复）；`checkAuth` 的 oauth 参数改必选；OAuth 请求体上限收拢为 `MAX_OAUTH_BODY_BYTES`。未采纳（判断题）：测试助手 `pkce()`/`register()` 下沉 `tests/support`（provider 级与进程级测试的 base URL 语义不同，强行统一反而绕）；客户端容量 200 淘汰最旧保留（参考实现同款护栏，淘汰连带该客户端未过期令牌失效属预期）。

- [x] 提供资源元数据端点，符合 RFC 9728，指向授权服务器
- [x] 提供授权服务器元数据端点，符合 RFC 8414
- [x] 支持动态客户端注册（RFC 7591），接受最多 10 个重定向 URI
- [x] 授权请求使用 PKCE S256，缺失或错误时拒绝
- [x] 授权页面要求输入本地 Bridge 令牌才允许批准，错误令牌不放行
- [x] `/mcp` 接受 OAuth access token；令牌无效时返回 401 并带 `WWW-Authenticate` 指向元数据
- [x] 支持 refresh token，并做轮换（旧的刷新后失效）
- [x] 令牌以哈希形式落盘，不以明文保存
- [x] 不影响已有的 Bearer 静态令牌路径（两条路并存）

**验收对照**（每条对应的证据）：

1. 资源元数据 RFC 9728 → `src/oauth.ts` `handle()` 的 protected-resource 分支（根路径与 `/mcp` 后缀都服务），测试 `tests/oauth.test.ts`「提供 RFC 9728 资源元数据与 RFC 8414 授权服务器元数据」+ `tests/oauth-http.test.ts`「无令牌请求 /mcp 返回 401…元数据 resource 是公网地址」
2. 授权服务器元数据 RFC 8414 → 同上 handle() 的 authorization-server 分支（issuer/端点/S256/grant_types 全断言）
3. 动态注册 RFC 7591，10 个 URI 上限 → `handleRegister()`，测试「动态注册 + PKCE 换令牌 + refresh 轮换」「接受 Gemini 应用连接器的真实注册负载（6 个重定向 URI + client_secret_post）」「超过 10 个重定向 URI 注册被拒」「支持公开客户端」
4. PKCE S256 缺失/错误即拒 → `validateAuthorizeParams()`（缺 challenge、method 非 S256、形状不合规均 400）+ `handleToken()` 的 verifier 常量时校验，测试「授权请求缺 PKCE 或方法不对时拒绝」「PKCE verifier 错误、未注册的 redirect_uri、非 https 重定向都被拒」
5. 授权页输本地令牌才批准 → `handleAuthorizePost()` 的 `approval_token` 常量时比较，测试「授权页不输入正确的本地令牌不放行」（错令牌 401、空令牌 401、不 302）
6. `/mcp` 接受 OAuth 令牌、401 带 `WWW-Authenticate` 指向元数据 → `mcpService.ts` `checkAuth()`（静态令牌优先，不匹配再验 OAuth）+ 401 头 `Bearer realm, resource_metadata, scope, error`，测试 oauth-http「无令牌请求 /mcp 返回 401…」「OAuth 全流程走通…OAuth 令牌连 MCP 列出 8 个工具」「无效的 OAuth 令牌被拒」
7. refresh 轮换 → `handleToken()` refresh 分支（旧 token 先删再发新），测试 oauth.test「动态注册 + PKCE 换令牌 + refresh 轮换」（重放 invalid_grant、新旧 refresh 不同）+ oauth-http「refresh 轮换：旧 refresh token 换新后失效，新 access token 可用」
8. 哈希落盘 → 存储键全部 `sha256(token)`，persist 原子替换（tmp+rename、mode 0o600），测试 oauth.test「令牌以哈希落盘，重启后仍然有效」（store 文件不含 access/refresh/approval 明文，reload 后仍验证通过）+ oauth-http「OAuth 令牌哈希落盘在 config 目录，文件里没有明文」
9. 静态 Bearer 并存 → 测试 oauth-http「静态 Bearer 令牌路径不受影响」（全流程 OAuth 跑完后静态令牌仍连 MCP 列出 8 个工具）；既有 `tests/http.test.ts` 全部原样通过

**已拍板的决策**（2026-11-21，小白点头）：

1. 端点路径照搬参考实现：`/.well-known/oauth-protected-resource`（含 `/mcp` 后缀）、`/.well-known/oauth-authorization-server`、`/oauth/register|authorize|token`。
2. OAuth 数据落盘 `config.json` 旁的 `oauth-store.json`（原子替换写盘）。
3. 授权页照参考实现：中文卡片页，批准需输入 `config.json` 的 `token`，拒绝回 `access_denied`。
4. `token` 非空时启用 OAuth，批准令牌就是 `config.token`；`token` 为空则 OAuth 整体关闭（授权页无口令可输），静态 Bearer 路径行为不变。

**复用来源：** 参考仓库 `D:\code\Nexus\Nexus` 的 commit `c8c18a7`（apps/bridge/src/oauth.ts，Gemini 实测跑通过的实现），移植后适配：`approvalSecret`/`publicBaseUrl` 支持函数形式（配置热重载后仍读最新值）、公网 base 从 `config.tunnelUrl` 推导（未配则回退本机地址）、限速内置进 provider（参考实现是 hook 留给调用方）、授权页令牌提示改为本仓库的 config.json 口径。commit `3efe8ec` 属启动脚本与文档修正，无需移植。

**超出票面的增量**：授权令牌连错 5 次/分钟限速（公网可达的批准入口防爆破，隧道转发头已纳入来源识别）；授权端点无参数时渲染说明页（面板授权入口直达不再撞 400）；面板 OAuth 入口点亮（spec「一屏六块」本就要求）。

## Comments

### 2026-11-21 实现（agent）

- 改动：新增 `src/oauth.ts`（OAuthProvider）、`tests/oauth.test.ts`（provider 级 13 条）、`tests/oauth-http.test.ts`（真实 dist 进程 7 条）；`src/mcpService.ts` 接入路由与双轨鉴权、401 元数据头、`oauthInfo()`；`src/panel.ts` 授权卡接入真实状态与提示文案。
- TTL：access 1h / refresh 30d / 授权码 5min；授权码一次性防重放；redirect_uri 限 https（http 仅 loopback，RFC 8252）；注册容量 200 淘汰最旧。
- 修正：票面原第 9 条「实际用 Gemini 网页版连一次」归属票 10（端到端连接验收），已从本票验收清单移除；实测步骤随票 10 走。
