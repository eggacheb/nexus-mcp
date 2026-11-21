# 04: `read` 与 `write`

**What to build:** 让 AI 能真正读取和写入沙箱目录里的文件。读的时候看到行号，可以按片段读大文件；写的时候整文件覆盖；所有路径都必须在根目录内。

**Blocked by:** 03

**Status:** done

- [x] `read` 返回带行号的内容，行号与文件真实行号一致
- [x] `offset` 与 `limit` 按行切分，超出文件末尾时返回已有部分而不是报错
- [x] 单次读取的行数有上限，超限时提示用 `offset` 继续
- [x] 非 UTF-8 文件返回可读错误，不返回乱码
- [x] `write` 整文件写入，内容按 UTF-8 编码，保留传入的换行风格
- [x] 写入的父目录不存在时返回可读错误，不自动创建
- [x] 越界路径（`..` 跳出、绝对路径指向根外、符号链接指向根外）一律拒绝，错误信息说明被拒绝的路径
- [x] 根目录本身不可写，避免 AI 删掉沙箱根
- [x] 路径解析对 Windows 盘符与反斜杠正确处理

## Comments

- 执行器新增 `read`/`write` 两个 op，`root` 按请求随行（与 bash 的 `cwd` 同款模式，面板改根目录立即生效）；TS 侧 `resolveInRoot` 保留为前置拒绝（错误信息带被拒路径），Rust 侧做权威校验。
- 沙箱校验两道：先词法规范化（`..` 处理 + `.`/`.` 跳出即拒，目标不存在时也报「越界」而不是误导性的「不存在」），再 `canonicalize` 真实路径比对（符号链接、Windows 大小写、8.3 短路径都归它管）。两道各自用同形态的根比较——踩过一个坑：词法目标对 canonicalize 根（`ADMINI~1` vs `Administrator`）会误判越界。
- 行号格式右对齐 6 位 + tab（`{:>6}\t`），`lines()` 切行天然吃掉 CRLF。limit 上限沿用 schema 已发布的 2000，Rust 侧防御性重复同值；字节上限沿用 `maxOutputBytes`，按整行截断，单行超预算时在字符边界截断（复用 `truncated_prefix`）。
- `write` 内容原样字节落盘（换行风格天然保留），不自动建目录；悬空符号链接拒绝写入而不是穿透创建（防 symlink 偷换出根）；根目录本身在词法阶段就拒绝。
- 测试形态：TS 侧 `tests/read-write.test.ts` 全部走 MCP 客户端入口，临时目录当根；符号链接本机无特权（EPERM），优先建文件链接、退回免特权的目录 junction 走同一条 canonicalize 校验链路，都造不出才 skip。Rust 侧 17 条算法级测试含 junction 逃逸与悬空链接防御。
- 既有 http 测试有两条断言匹配的是 stub 文本（`toContain("package.json")`），read 接真后改为断言真实文件内容字段；smoke 自检原读不存在的 `README.md`，改为读 `package.json` 并在 isError 时退出非零（票外小改）。
