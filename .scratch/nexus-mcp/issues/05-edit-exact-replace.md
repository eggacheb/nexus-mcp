# 05: `edit` 精确替换

**What to build:** AI 用「给一段原文、给一段新文」的方式改代码，工具只在原文唯一出现时才动手，出现多处就失败并说明，避免改错位置。匹配要容忍缩进和空白的细微差异，匹配算法以 opencode 的三级降级实现为主路径。

**Blocked by:** 04

**Status:** done

- [x] `old_string` 在文件中唯一出现时，替换成功并返回改动位置
- [x] `old_string` 出现多处且未指定 `replace_all` 时，失败并报「匹配到 N 处」
- [x] `old_string` 完全不存在时失败，并提示可能是缩进或空白差异
- [x] `replace_all` 为真时替换所有匹配，并返回替换数量
- [x] 行尾空白有轻微差异时仍能定位（第三级按整行窗口对齐，不会跨越大段代码误匹配）；行首缩进必须一致（照搬 opencode 的 trimEnd），对不上时靠 missHint 提示真实缩进让模型重试
- [x] 替换后保留原文件的换行风格（CRLF 或 LF 不被改写）
- [x] 混合行尾的文件（同一文件里 CRLF 与 LF 并存）替换后各行保持自己的行尾，不被统一改写
- [x] 替换后文件仍是合法 UTF-8，不产生乱码
- [x] 空 `old_string` 被拒绝，避免整文件被清空
- [x] 算法层有单元测试覆盖：唯一匹配、多匹配、无匹配、空白差异、跨行块

**复用来源：** 主路径搬 opencode 的 `core/src/tool/plugin/edit.ts`：三级匹配降级（精确 → Unicode 归一化 → 行级尾空白匹配）、CRLF 双向保真（LF 视图匹配 + LCS 对齐回写行尾）、missHint（匹配失败时按忽略空白的行投票定位最近 12 行并带行号提示）、「newString 已在文件中 = 编辑已应用过」检测。算法部分是纯字符串函数，剥掉 Effect 壳即可搬，见 `docs/research/opencode-reusable-parts.md` §1。codex `apply-patch` 的 `parser.rs`/`seek_sequence.rs` 降级为「后续要支持 patch 文本」时的备选（见 `docs/research/codex-reusable-parts.md` §2.1），本票不引入该 crate。

## Comments

- 2026-11-21 决策：原第 5 条写「缩进层级或行尾空白有轻微差异时仍能定位」，与 opencode 第三级 `trimEnd`（只容忍行尾空白、行首缩进必须一致）冲突。定案**照搬 opencode**：只容忍行尾空白，缩进必须一致；缩进对不上时靠 missHint（投票定位最近 12 行带行号）让模型看清真实缩进后重试。第 5 条已按此改写。
- 2026-11-21 完成：算法搬进执行器 `crates/executor/src/edit_match.rs`（opencode `edit.ts` 的 Rust 移植，Effect 壳剥掉）。两处移植要点：① JS 版归一化按 UTF-16 逐字符替换、偏移不变，Rust 按字节会漂移，归一化层改为按字符逐位比较（`find_normalized_occurrences`）直接产出视图字节区间；② 「缩进必须一致」约束的是**多行块**的行级模糊层，单行 `old_string` 是子串搜索，会命中行中同文片段（opencode 本来的行为）。协议层新增 `edit` op（唯一性/replace_all/空串判定在执行器，与 read 共用沙箱校验 `open_within_sandbox`），TS 侧 `edit` 工具换成真实调用。测试：`edit_match.rs` 16 个算法用例 + `main_tests.rs` 4 个协议用例 + `tests/edit.test.ts` 12 条 MCP 客户端用例，`npm run check` 全绿。
