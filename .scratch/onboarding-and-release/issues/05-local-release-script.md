# 05: 本地一键 Release 脚本与 SHA256 校验和发布

**What to build:** 提供遵守 ADR-0003（不启用 GitHub Actions）的本地一键发布入口 `npm run release [-- <semver>] [--publish]`，自动完成版本号跨文件同步、全量检验与双产物打包、`release/SHA256SUMS.txt` 生成，并在本机 `gh` CLI 可用时创建 GitHub Draft Release（`--publish` 直接发布），未装 `gh` 时给出清晰的本地产物与手动上传指引。

**Blocked by:** 04: NSIS 优雅退出、卸载清理与用户向文档改写

**Status:** done

- [x] 新增 `scripts/release.mjs` 并在 `package.json` 注册 `"release"` 脚本，支持参数 `[<semver>]`、`--publish`、`--skip-check`（测试隔离用）。
- [x] 传入 `<semver>` 时校验语义化版本格式并同步更新 `package.json`、`crates/executor/Cargo.toml`、`crates/tray/Cargo.toml` 中的版本号（不传则沿用当前版本）。
- [x] 默认串行执行全量 `npm run check`、`npm run package`、`npm run package:smoke`（遵循 Windows Node 24 CVE-2024-27980 安全调用方式），并计算 `release/` 下安装包与绿色 zip 的 SHA-256 写入 `release/SHA256SUMS.txt`。
- [x] 检测本机 `gh` CLI 可用性与登录状态：可用时调用 `gh release create v<version> <setup> <zip> <SHA256SUMS.txt>`（默认带 `--draft`，传 `--publish` 时去掉 `--draft`）；不可用或未登录时打印产物清单与手动上传命令并以退出码 `0` 结束；绝不创建 `.github/workflows/` 或静默强推未确认的 git 提交。
- [x] 同步在 `README.md` 与 `AGENTS.md` 补充 `npm run release` 用法说明。
- [x] 新增 `tests/release.test.ts`，在临时隔离目录配合 stub `gh` 验收：三文件版本号同步、非法版本号拒绝、`SHA256SUMS.txt` 校验和准确性、默认 `--draft` 与 `--publish` 参数透传、以及 `gh` 缺失时的降级输出。

## Comments

- 验收清单 1、2、6 → `tests/release.test.ts > 本地一键 Release 脚本（scripts/release.mjs） > 拒绝非法语义化版本号且不修改仓库文件`
- 验收清单 1–4、6 → `tests/release.test.ts > 本地一键 Release 脚本（scripts/release.mjs） > 同步版本号到全部清单、生成精确 SHA256SUMS.txt，并默认以 --draft 调用 gh（传 --publish 去掉 --draft）`
- 验收清单 4、6 → `tests/release.test.ts > 本地一键 Release 脚本（scripts/release.mjs） > 未安装 gh 时优雅降级：退出码 0 并打印本地产物与手动上传指引`（3/3 通过）
