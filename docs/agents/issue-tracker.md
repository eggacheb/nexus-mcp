# Issue tracker: Local Markdown

Issue 与 spec 都以 markdown 文件形式存放在本仓库的 `.scratch/` 下。本仓库有 GitHub 远程，但 issue 不放 GitHub Issues——工具链全部走本地文件。

## 约定

- 一个功能一个目录：`.scratch/<feature-slug>/`（如 `.scratch/nexus-mcp/`、`.scratch/self-hosting-ergonomics/` 等）
- spec 是 `.scratch/<feature-slug>/spec.md`
- 实现票一票一文件：`.scratch/<feature-slug>/issues/<NN>-<slug>.md`，从 `01` 编号，禁止把所有票塞进一个文件
- 票的 triage 状态写在文件靠上的 `Status:` 行。本仓库在用的取值：`ready-for-agent`（可开工）、`done`（完成；票做完在 `## Comments` 注明每条验收清单对应哪个测试用例）
- 讨论记录追加到文件底部的 `## Comments` 标题下

## 技能说「publish to the issue tracker」时

在 `.scratch/<feature-slug>/` 下新建文件（目录不存在就创建）。

## 技能说「fetch the relevant ticket」时

直接读指定路径的文件。用户通常会给出路径或票号。

## Wayfinding 操作

供 `/wayfinder` 使用。**map** 是主文件，每张票对应一个子文件：

- **Map**：`.scratch/<effort>/map.md`
- **子票**：`.scratch/<effort>/issues/NN-<slug>.md`，从 `01` 编号，正文写问题本身。`Type:` 行记录类型（`research`/`prototype`/`grilling`/`task`）；`Status:` 行记录 `claimed`/`resolved`
- **依赖**：文件靠上的 `Blocked by: NN, NN` 行。所列文件全部 `resolved` 后，该票才解除阻塞
- **Frontier**：扫 `.scratch/<effort>/issues/` 里未完成、未阻塞、未认领的票，编号最小的优先
- **认领**：改 `Status: claimed` 并保存，然后才动手
- **解决**：在 `## Answer` 标题下写结论，改 `Status: resolved`，再把上下文指针追加到 `map.md` 的 Decisions-so-far 里
