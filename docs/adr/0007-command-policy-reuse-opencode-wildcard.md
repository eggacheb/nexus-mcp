# 命令闸门的通配引擎用 opencode，不搬 codex execpolicy-rules

Status: accepted

票 08 原计划直接搬 codex 的 `execpolicy-rules` crate，开工前调查推翻了两点：opencode `packages/core/src/util/wildcard.ts` 的通配引擎零依赖且更轻，够白/黑名单用；codex 的规则表没有 `format`/`diskpart`/`reg delete` 这几条 Windows 危险命令。最终：通配匹配移植 opencode（MIT），可执行名归一化取 codex `command_safety` 的 `executable_name_lookup_key` 形状，危险规则表以 codex 的 rm 谓词与 cmd/PowerShell 删除类规则为底、磁盘与注册表三条自写。教训沉淀：写票时复用来源写「意图 + 候选清单」，别把机制写成唯一解——开工前的调查有权推翻票面选型。
