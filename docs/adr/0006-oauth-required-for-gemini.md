# OAuth 2.1 是接入 Gemini 的前提

Status: accepted

Gemini 网页版自定义 MCP 只接受 `https://` 地址加 OAuth 鉴权，没有填 Bearer 头的位置——这是立项的原始约束（spec Problem Statement 第一句）。所以协议层实现了完整 OAuth 2.1 授权服务：RFC 9728/8414 元数据发现、动态客户端注册、PKCE S256、refresh token 轮换，授权页要求输入本地令牌才批准。静态 Bearer 是通用客户端的并行走法（先比对 Bearer，不匹配再验 OAuth）。`token` 为空时不校验任何请求，仅限本机调试；配隧道就必须设 token。
