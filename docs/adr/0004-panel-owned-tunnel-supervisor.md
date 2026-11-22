# 隧道守护做成面板内置重启

Status: accepted

cloudflared 的保活有三条实测走不通的路，别再试：`cloudflared service install` 装出来的服务 binPath 不带 `tunnel run`，SCM 一拉起就退出（把配置复制进 systemprofile 也没用）；计划任务 AtLogOn 登录后实测不触发，而且这个任务删不掉也禁用不了；循环守护 vbs 要多养一个常驻 wscript，面板「停止」还得引入停止标记文件。最终方案：面板对自家拉起的 cloudflared 进程做监控，异常退出 10 秒后拉回（`tunnel.autoRestart: false` 可关），面板「停止隧道」不触发守护，想停就停得住。代价是守护跟随服务进程——服务挂了没人拉隧道；可接受：8787 是服务监听的，服务死了隧道独活，Gemini 照样连不上。实测记录在 `docs/tunnel.md`。
