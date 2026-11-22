# 打包用 Node SEA 单 exe 加 NSIS 安装包与 zip

Status: accepted

目标机器不装 Rust 与 Node。协议层用 Node 24 自带的 SEA（single executable application）打成单 exe，与 Rust 执行器 exe、`config.json`、启动脚本同目录分发；对外发布两个产物：NSIS 安装包（按用户装、不弹 UAC、带卸载入口）与 zip 绿色版（票 11 拍板）。选 SEA 是因为 Node 24 原生自带、不引第三方打包器。刻意不做：开机自启安装项（自启交用户手动放 vbs）、代码签名（有需求再买证书）。`release/` 产物不进版本库。
