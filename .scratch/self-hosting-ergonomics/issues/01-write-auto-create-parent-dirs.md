# 01: `write` 自动创建沙箱内缺失父目录

**What to build:** 让 `write` 工具在目标路径的父目录不存在时自动创建**沙箱根**内的缺失目录，省去新建子目录文件前必须先跑 `bash` `mkdir -p` 的往返，同时守住**沙箱根**词法与符号链接越界红线。

**Blocked by:** None (可立即开工)

**Status:** done

- [x] `write` 写入**沙箱根**内尚不存在的单层或多层嵌套子目录文件时，自动创建缺失父目录并成功落盘返回写入字节数。
- [x] 当目标路径包含 `..` 越界，或路径上已存在的祖先目录是指向**沙箱根**之外的符号链接时，`write` 在创建任何目录前直接拒绝并返回可读越界错误。
- [x] 当目标路径的某个父级路径实际是已存在的普通文件而非目录时，`write` 拒绝写入并返回清晰错误，不破坏既有文件。
- [x] 更新 `write` 工具描述与**面板** `TOOL_SUMMARY`（去掉「不自动建目录」的旧说明），并确认 `tests/panel.test.ts` 工具清单一致性校验通过。
- [x] 通过 MCP 客户端入口（`tests/read-write.test.ts`）与 Rust 执行层测试覆盖自动建目录、多层嵌套、符号链接越界拒绝与父级为文件冲突场景。

## Comments

- 验收清单 1 → `crates/executor/src/main_tests.rs > write_op_auto_creates_missing_parent_dirs_within_sandbox`、`tests/read-write.test.ts > read/write 工具 > 写入的父目录不存在时自动创建沙箱内缺失目录并成功落盘`
- 验收清单 2 → `crates/executor/src/main_tests.rs > write_op_rejects_dotdot_escape_and_names_the_path`、`write_op_rejects_symlink_escape_and_names_the_path`、`write_op_rejects_nested_missing_dir_under_escape_symlink`、`tests/read-write.test.ts > read/write 工具 > 越界路径一律拒绝，错误信息说明被拒绝的路径`
- 验收清单 3 → `crates/executor/src/main_tests.rs > write_op_rejects_parent_component_that_is_existing_file`、`tests/read-write.test.ts > read/write 工具 > 父路径上某一段是已存在的普通文件时拒绝写入且不破坏原文件`
- 验收清单 4、5 → `tests/panel.test.ts > 本地控制面板 > 面板列出的工具与 MCP 实际注册的一致`、`tests/read-write.test.ts`（12/12 通过）、`tests/panel.test.ts`（21/21 通过）
