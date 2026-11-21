# 06: `glob` 与 `grep`

**What to build:** AI 先找文件再读内容，而不是把整棵树塞进上下文。`glob` 按通配符返回路径并按最近修改排序，`grep` 按正则返回文件名、行号和该行内容，两者都遵守 `.gitignore`。

**Blocked by:** 03

**Status:** ready-for-agent

- [ ] `glob` 返回匹配的路径列表，按修改时间从新到旧
- [ ] `glob` 默认遵守 `.gitignore`，不返回 `node_modules`、`dist` 这类目录里的文件
- [ ] `glob` 支持指定搜索起点，起点同样受沙箱约束
- [ ] `grep` 返回文件名、行号、匹配行内容
- [ ] `grep` 支持 `glob` 参数限定文件范围、`ignore_case` 控制大小写
- [ ] `grep` 底层调用 ripgrep，不自己实现遍历，未安装 ripgrep 时给出明确提示
- [ ] 结果数量超限时截断，并说明「还有更多」
- [ ] 无匹配时返回空结果加一句说明，不当作错误
- [ ] 二进制文件被跳过，不把乱码塞进结果

**复用来源：** 遍历参数抄 codex `file-search` 里 `WalkBuilder` 的配置（`hidden(false)`、`follow_links(true)`、`require_git(true)`、可关全部 ignore 规则），约 20 行，见 `docs/research/codex-reusable-parts.md` §2.2。**不要**直接用它做 `glob`：那个 crate 是 fzf 式模糊评分排序（`nucleo` 打分），语义不是 glob 精确匹配。ripgrep 的调用组合与二进制保障照抄 opencode：`core/src/ripgrep.ts` 的 args 集（`--no-config --json --no-messages`、`take(limit+1)` 做截断检测、非 UTF-8 行 base64 解码）与 `core/src/ripgrep/binary.ts` 的发现链（PATH → 全局缓存 → 下载 pinned 版本 + SHA-256 校验；Windows 用 System32 自带的 bsdtar 解 zip，避开 GNU tar 读不了 zip 和 ANSI 代码页对中文用户名路径的坑），见 `docs/research/opencode-reusable-parts.md` §1。codex 侧 grep 无可抄（它自己也调外部 rg）。
