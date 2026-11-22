# 不用 GitHub Actions，CI 全部本地跑

Status: accepted

推送 workflow 文件有账号风险，这条是硬约束。全部检查收进一条本地命令 `npm run check`（build + vitest + cargo test + smoke），提交前必须全绿；pre-push 钩子会跑它。要加检查就往这条命令和 `scripts/hooks/` 里加，不要建 `.github/`。
