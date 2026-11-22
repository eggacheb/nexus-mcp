# HTTP 默认端口 8787，服务迁就既有隧道而不是改隧道

Status: accepted

本机已有一条能工作的 cloudflared 隧道（`nexus.maliy.top` → `127.0.0.1:8787`），Gemini 连接器里记录的就是这个域名。服务默认端口取 8787，接管时隧道配置一行不改；改 `config.yml` 要动 Cloudflare 侧已验证的链路，而域名连着云端的连接器配置，风险大收益零。代价是 8787 同时只能有一个监听者：升级、旧系统（`localbridge-desktop.exe`）复活时都要先清端口，见 `docs/tunnel.md`。
