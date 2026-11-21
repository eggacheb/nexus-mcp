# 05: `edit` 精确替换

**What to build:** AI 用「给一段原文、给一段新文」的方式改代码，工具只在原文唯一出现时才动手，出现多处就失败并说明，避免改错位置。匹配要容忍缩进和空白的细微差异，匹配算法以 opencode 的三级降级实现为主路径。

**Blocked by:** 04

**Status:** ready-for-agent

- [ ] `old_string` 在文件中唯一出现时，替换成功并返回改动位置
- [ ] `old_string` 出现多处且未指定 `replace_all` 时，失败并报「匹配到 N 处」
- [ ] `old_string` 完全不存在时失败，并提示可能是缩进或空白差异
- [ ] `replace_all` 为真时替换所有匹配，并返回替换数量
- [ ] 缩进层级或行尾空白有轻微差异时仍能定位（模糊匹配），但不会跨越大段代码误匹配
- [ ] 替换后保留原文件的换行风格（CRLF 或 LF 不被改写）
- [ ] 混合行尾的文件（同一文件里 CRLF 与 LF 并存）替换后各行保持自己的行尾，不被统一改写
- [ ] 替换后文件仍是合法 UTF-8，不产生乱码
- [ ] 空 `old_string` 被拒绝，避免整文件被清空
- [ ] 算法层有单元测试覆盖：唯一匹配、多匹配、无匹配、空白差异、跨行块

**复用来源：** 主路径搬 opencode 的 `core/src/tool/plugin/edit.ts`：三级匹配降级（精确 → Unicode 归一化 → 行级尾空白匹配）、CRLF 双向保真（LF 视图匹配 + LCS 对齐回写行尾）、missHint（匹配失败时按忽略空白的行投票定位最近 12 行并带行号提示）、「newString 已在文件中 = 编辑已应用过」检测。算法部分是纯字符串函数，剥掉 Effect 壳即可搬，见 `docs/research/opencode-reusable-parts.md` §1。codex `apply-patch` 的 `parser.rs`/`seek_sequence.rs` 降级为「后续要支持 patch 文本」时的备选（见 `docs/research/codex-reusable-parts.md` §2.1），本票不引入该 crate。
