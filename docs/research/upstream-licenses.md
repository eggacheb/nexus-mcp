# 上游与复用来源的 License 调查

调查时间：2026-11-22。方法：GitHub API 仓库元数据 + LICENSE 文件原文（`gh api` / raw.githubusercontent），
以及本仓库票据与调研笔记的移植记录交叉核对。所有结论都追到了一手来源。

## 结论一览

| 项目 | 与本仓库的关系 | License | 证据 |
| --- | --- | --- | --- |
| [ysunyang4/Nexus](https://github.com/ysunyang4/Nexus) | 上上游（原作，非 fork，仍在活跃维护，最后推送 2026-11-22） | **AGPL-3.0** | GitHub license 检测 `AGPL-3.0`；`LICENSE` 全文 33,830 字节，头部为「GNU AFFERO GENERAL PUBLIC LICENSE Version 3, 19 November 2007」 |
| [shixian64/Nexus](https://github.com/shixian64/Nexus) | 上游（`ysunyang4/Nexus` 的 fork） | **AGPL-3.0** | GitHub license 检测 `AGPL-3.0`；fork 自带同尺寸 LICENSE（33,830 字节） |
| [anomalyco/opencode](https://github.com/anomalyco/opencode) | 代码移植来源（MIT） | **MIT** | LICENSE 原文：「MIT License / Copyright (c) 2025 opencode」。`sst/opencode` API 请求被重定向到 `anomalyco/opencode`，规范仓库以 anomalyco 为准，NOTICE 的链接正确 |
| [openai/codex](https://github.com/openai/codex) | 代码移植来源（Apache-2.0） | **Apache-2.0** | LICENSE 原文：「Apache License / Version 2.0, January 2004」 |

## 关键事实：nexus-mcp 是 Nexus 的衍生作品

票 09（`.scratch/nexus-mcp/issues/09-oauth.md:40`）的复用来源原文：

> 参考仓库 `D:\code\Nexus\Nexus` 的 commit `c8c18a7`（apps/bridge/src/oauth.ts，Gemini 实测跑通过的实现），移植后适配：……

- 本机参考仓库 `D:\code\Nexus\Nexus` 的 remote 结构：`origin → eggacheb/Nexus`（用户自己的 fork）、
  `forkparent → shixian64/Nexus`、`upstream → ysunyang4/Nexus`；`c8c18a7`（「feat(bridge): add OAuth 2.1
  server for Gemini web custom MCP connectors」）就在该仓库历史中。
- 因此 `src/oauth.ts` 包含从 AGPL-3.0 项目**移植的代码**（不止「实现思路」），nexus-mcp 整体构成
  Nexus 的衍生作品。spec.md「传输与鉴权」一节写的「复用 Nexus 桥接层已有的实现思路」低估了这一层，
  实际是代码移植，以票 09 的记录为准。

## AGPL-3.0 对本仓库意味着什么

AGPL-3.0 与普通 GPL 的差别在第 13 条：**通过网络提供服务也算「交互」，必须向使用服务的用户
提供对应源码**，且衍生作品整体必须以 AGPL-3.0 授权发布。

对照本仓库现状：

1. 仓库没有 `LICENSE` 文件——当前处于「默认保留所有权利」却包含 AGPL 衍生代码的状态，不合规。
2. GitHub release 分发安装包与 zip 二进制：公开源码仓库可以满足「对应源码」要求，但需要 LICENSE
   明确声明 AGPL-3.0，并保留 Nexus 的版权声明。
3. `NOTICE` 目前只列了 codex 与 opencode，缺 Nexus 条目（移植范围：`apps/bridge/src/oauth.ts` → `src/oauth.ts`）。
4. MIT / Apache-2.0 的移植部分（opencode、codex）义务更轻：保留版权与许可声明即可，`NOTICE` 已覆盖。

### 待办（合规最低集，涉及授权选择，须由仓库所有者拍板）

1. 根目录添加 `LICENSE`（AGPL-3.0 全文）。
2. `NOTICE` 增加 Nexus 条目：来源仓库（ysunyang4/Nexus，经 shixian64/Nexus 与 eggacheb/Nexus fork 链）、
   许可证 AGPL-3.0、移植文件映射。
3. README 致谢节补一句「本仓库以 AGPL-3.0 发布」。
4. （可选）spec.md L72 的「实现思路」表述改为与票 09 一致的「移植后适配」。

## 本调查的局限

- 只核对了四个仓库的 LICENSE 文件与其依赖的许可证合规性（如 Nexus 自身的依赖链）未展开。
- opencode 的 NOTICE 版权行写「Copyright 2025 SST / OpenCode contributors」，而 LICENSE 原文是
  「Copyright (c) 2025 opencode」——措辞有偏差，不影响 MIT 义务的履行，修正时顺手对齐即可。
- 本文档是工程调查记录，不构成法律意见；AGPL 的适用边界（如私有部署是否触发第 13 条）拿不准时咨询专业人士。
