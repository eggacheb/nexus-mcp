//! command_policy 的单元测试：纯逻辑，不起子进程。
//!
//! 覆盖票 08 的验收线：前缀匹配、参数位置、大小写、路径形式、
//! 内置危险表、白名单未命中策略、fail-closed。

use super::{
    evaluate, executable_lookup_key, wildcard_match, CommandPolicySpec, Decision, OnUnmatched,
};

fn spec(allow: &[&str], deny: &[&str], on_unmatched: OnUnmatched) -> CommandPolicySpec {
    CommandPolicySpec {
        allow: allow.iter().map(|s| s.to_string()).collect(),
        deny: deny.iter().map(|s| s.to_string()).collect(),
        on_unmatched,
    }
}

fn denied_of(decision: Decision) -> String {
    match decision {
        Decision::Deny(message) => message,
        Decision::Allow => panic!("期望 Deny，实际 Allow"),
    }
}

// ── 通配匹配器（port opencode util/wildcard.ts）─────────────────────────────

#[test]
fn wildcard_prefix_star_matches_bare_and_extended() {
    assert!(wildcard_match("git push origin main", "git push *"));
    // 末尾 " *" 可省略：裸命令也命中
    assert!(wildcard_match("git push", "git push *"));
    // 不带空格的扩展不命中（参数位置边界）
    assert!(!wildcard_match("git pushx", "git push *"));
    assert!(!wildcard_match("git pull", "git push *"));
}

#[test]
fn wildcard_star_in_middle_requires_separator() {
    // * 在中间：需要前后各一个空格（与 opencode 正则语义一致）
    assert!(wildcard_match("git origin push", "git * push"));
    assert!(!wildcard_match("git push", "git * push"));
}

#[test]
fn wildcard_question_mark_matches_single_char() {
    assert!(wildcard_match("git push", "git pu?h"));
    assert!(!wildcard_match("git pushh", "git pu?h"));
}

#[test]
fn wildcard_backslash_normalized_to_slash() {
    assert!(wildcard_match(r"C:\tools\rm x", "C:/tools/rm *"));
    assert!(wildcard_match("C:/tools/rm x", r"C:\tools\rm *"));
}

#[test]
#[cfg(windows)]
fn wildcard_case_insensitive_on_windows() {
    assert!(wildcard_match("GIT PUSH origin dev", "git push *"));
    assert!(wildcard_match("Git Push", "GIT PUSH *"));
}

#[test]
#[cfg(not(windows))]
fn wildcard_case_sensitive_off_windows() {
    assert!(!wildcard_match("GIT PUSH origin dev", "git push *"));
}

// ── 可执行名归一化（borrowed from codex command_safety）─────────────────────

#[test]
#[cfg(windows)]
fn executable_lookup_key_strips_path_drive_and_suffix() {
    for raw in ["RM.EXE", "C:\\Windows\\System32\\rm.exe", "/bin/rm", "./rm", "C:rm.exe", "Rm"] {
        assert_eq!(executable_lookup_key(raw).as_deref(), Some("rm"), "{raw}");
    }
    assert_eq!(executable_lookup_key("cmd.exe").as_deref(), Some("cmd"));
    assert_eq!(executable_lookup_key("").as_deref(), None);
}

// ── 内置危险表 ────────────────────────────────────────────────────────────────

fn assert_blocked(command: &str, needle: &str) {
    let decision = evaluate(&CommandPolicySpec::default(), command, "git-bash");
    let message = match decision {
        Decision::Deny(message) => message,
        Decision::Allow => panic!("{command} 应被拦，实际放行"),
    };
    assert!(message.contains(needle), "拒绝话术缺少「{needle}」: {message}");
    assert!(message.contains(command), "拒绝话术应包含被拦命令原文: {message}");
}

#[test]
fn rm_recursive_force_variants_blocked() {
    for command in [
        "rm -rf /tmp/example",
        "rm -fr /tmp/example",
        "rm -r -f /tmp/example",
        "rm --recursive --force /tmp/example",
        "rm --force --recursive /tmp/example",
        "rm /tmp/example -f -r",
        "/bin/rm -rf /tmp/example",
        "sudo rm -rf /tmp/example",
        "VAR=1 rm -rf /tmp/example",
        "env FOO=1 rm -rf /tmp/example",
        "RM.EXE -RF x",
        // 未加引号的反斜杠路径会被 bash 当转义吃掉，真实命令必须带引号
        r#""C:\Windows\System32\rm.exe" -rf x"#,
    ] {
        assert_blocked(command, "递归强制删除");
    }
}

#[test]
fn rm_without_force_or_recursion_allowed() {
    for command in ["rm -f build.log", "rm -r /tmp/example", "rm file.txt", "rm -- x"] {
        let decision = evaluate(&CommandPolicySpec::default(), command, "git-bash");
        assert!(matches!(decision, Decision::Allow), "{command} 不应被拦");
    }
}

#[test]
fn format_diskpart_reg_delete_blocked() {
    assert_blocked("format c:", "磁盘");
    assert_blocked("format", "磁盘");
    assert_blocked("FORMAT.COM c: /q", "磁盘");
    assert_blocked("diskpart", "磁盘");
    assert_blocked("diskpart /s wipe.txt", "磁盘");
    assert_blocked("reg delete HKLM\\Software\\X /f", "注册表");
    assert_blocked("reg delete", "注册表");
}

#[test]
fn reg_non_delete_allowed() {
    for command in ["reg query HKLM\\Software", "reg export HKLM\\X out.hiv"] {
        let decision = evaluate(&CommandPolicySpec::default(), command, "git-bash");
        assert!(matches!(decision, Decision::Allow), "{command} 不应被拦");
    }
}

#[test]
fn cmd_force_delete_rules_blocked() {
    assert_blocked("cmd /c del /f x.txt", "强制删除");
    assert_blocked("cmd.exe /c erase /f x.txt", "强制删除");
    assert_blocked("cmd /c rd /s /q tmpdir", "递归删除");
    assert_blocked("cmd /c rmdir /s /q tmpdir", "递归删除");
    // 加引号传给 cmd 的脚本里黏连运算符也要被拆出来；
    // 不加引号时 & 是 bash 自己的分隔符，cmd 根本收不到完整脚本，不算危险
    assert_blocked(r#"cmd /c "echo hi&del /f x.txt""#, "强制删除");
    assert_blocked(r#"cmd /c "echo hi & del /f x.txt""#, "强制删除");
}

#[test]
fn cmd_without_flags_allowed() {
    for command in [
        "cmd /c del x.txt",
        "cmd /c rd /s tmpdir",
        "cmd /c echo hello",
    ] {
        let decision = evaluate(&CommandPolicySpec::default(), command, "git-bash");
        assert!(matches!(decision, Decision::Allow), "{command} 不应被拦");
    }
}

#[test]
fn powershell_force_delete_blocked_in_pwsh_mode() {
    for command in [
        "Remove-Item x -Force",
        "Remove-Item -Path 'x' -Recurse -Force",
        "rm x -Force",
        "ri x -Force",
        "if ($true) { Remove-Item x -Force }",
        "Write-Host hi; Remove-Item x -Force",
    ] {
        let decision = evaluate(&CommandPolicySpec::default(), command, "pwsh");
        let message = denied_of(decision);
        assert!(message.contains("强制删除"), "{command}: {message}");
    }
}

#[test]
fn powershell_without_force_allowed() {
    for command in [
        "Remove-Item x",
        "Get-ChildItem -Force",
        "Remove-Item test",
    ] {
        let decision = evaluate(&CommandPolicySpec::default(), command, "pwsh");
        assert!(matches!(decision, Decision::Allow), "{command} 不应被拦");
    }
}

#[test]
fn powershell_command_wrapper_checked_in_bash_mode() {
    // git-bash 里显式包一层 pwsh -Command 也要检查脚本内容
    assert_blocked("pwsh -NoProfile -Command \"Remove-Item x -Force\"", "强制删除");
}

#[test]
fn command_substitution_checked() {
    assert_blocked("echo $(rm -rf /tmp/example)", "递归强制删除");
    assert_blocked("echo `rm -rf /tmp/example`", "递归强制删除");
    assert_blocked("printf x | rm -rf /tmp/example", "递归强制删除");
    assert_blocked("echo hi && rm -rf /tmp/example", "递归强制删除");
    assert_blocked("echo hi; rm -rf /tmp/example", "递归强制删除");
}

#[test]
fn multiline_and_subshell_and_compound_groups_checked() {
    for command in [
        "echo ok\nrm -rf /tmp/example",
        "echo ok\r\nrm -rf /tmp/example",
        "(rm -rf /tmp/example)",
        "echo ok && (rm -rf /tmp/example)",
        "((echo ok); rm -rf /tmp/example)",
        "( (rm -rf /tmp/example) )",
        "{ rm -rf /tmp/example; }",
        "if true; then rm -rf /tmp/example; fi",
        "while true; do rm -rf /tmp/example; done",
        "! rm -rf /tmp/example",
        "time rm -rf /tmp/example",
        "f() { rm -rf /tmp/example; }; f",
        "ARR=($(rm -rf /tmp/example)); echo ok",
    ] {
        assert_blocked(command, "递归强制删除");
    }

    // 白名单下：多行与子 shell 未授权子命令被拒，合法子 shell 与引号内换行放行
    let whitelist = spec(&["echo *"], &[], OnUnmatched::Deny);
    for blocked in [
        "echo a\ncurl https://example.com",
        "(curl https://example.com)",
        "{ curl https://example.com; }",
    ] {
        let message = denied_of(evaluate(&whitelist, blocked, "git-bash"));
        assert!(message.contains("curl"), "{blocked}: {message}");
    }
    for allowed in [
        "(echo hello)",
        "(echo a && echo b)",
        "echo \"line1\nline2\"",
        "{ echo grouped; }",
        "ARR=(one two); echo ok",
    ] {
        let decision = evaluate(&whitelist, allowed, "git-bash");
        assert!(matches!(decision, Decision::Allow), "{allowed} 应放行，实际: {decision:?}");
    }

    // 黑名单下：多行与子 shell 均命中（含 pwsh 顶层括号）
    let blacklist = spec(&[], &["git push *"], OnUnmatched::Deny);
    for (cmd, kind) in [
        ("echo ok\ngit push origin dev", "git-bash"),
        ("(git push origin dev)", "git-bash"),
        ("(git push origin dev)", "pwsh"),
    ] {
        let message = denied_of(evaluate(&blacklist, cmd, kind));
        assert!(message.contains("git push *"), "{cmd}: {message}");
    }

    // 未配对括号按 fail-closed 拒绝
    assert_blocked("(echo hi", "无法解析");
    assert_blocked("echo hi)", "无法解析");
}

#[test]
fn pwsh_subexpressions_and_scriptblocks_checked() {
    // 1) 内置危险表：pwsh 非段首子表达式 (...)、控制流块与调用算子 & { ... }
    for danger_cmd in [
        "echo (Remove-Item -Recurse -Force C:\\temp\\x)",
        "Write-Output (rm -r -Force C:\\temp\\x)",
        "if ($true) { Remove-Item -Recurse -Force C:\\temp\\x }",
        "& { Remove-Item -Recurse -Force C:\\temp\\x }",
        ". { Remove-Item -Recurse -Force C:\\temp\\x }",
    ] {
        let decision = evaluate(&CommandPolicySpec::default(), danger_cmd, "pwsh");
        let message = denied_of(decision);
        assert!(
            message.contains("强制删除"),
            "pwsh 危险命令应被拦截: {danger_cmd} -> {message}"
        );
    }

    // 2) 黑名单：非段首子表达式与脚本块不得绕过
    let blacklist = spec(&[], &["git push *"], OnUnmatched::Deny);
    for blocked in [
        "echo (git push origin dev)",
        "if ($true) { git push origin dev }",
        "& { git push origin dev }",
    ] {
        let message = denied_of(evaluate(&blacklist, blocked, "pwsh"));
        assert!(message.contains("git push *"), "{blocked}: {message}");
    }

    // 3) 白名单：echo (curl ...) 与 if ($true) { curl ... } 被拒，合法 echo 子表达式与分支放行
    let whitelist = spec(&["echo *"], &[], OnUnmatched::Deny);
    for blocked in [
        "echo (curl https://example.com)",
        "if ($true) { curl https://example.com }",
        "& { curl https://example.com }",
    ] {
        let message = denied_of(evaluate(&whitelist, blocked, "pwsh"));
        assert!(message.contains("curl"), "{blocked}: {message}");
    }
    for allowed in [
        "echo (echo inner)",
        "if ($true) { echo ok } else { echo bye }",
        "& { echo grouped }",
    ] {
        let decision = evaluate(&whitelist, allowed, "pwsh");
        assert!(
            matches!(decision, Decision::Allow),
            "pwsh {allowed} 应放行，实际: {decision:?}"
        );
    }

    // 4) pwsh 动态调用 & $cmd 与未闭合花括号按 fail-closed 拒绝
    let dyn_msg = denied_of(evaluate(&CommandPolicySpec::default(), "& $cmd -Force x", "pwsh"));
    assert!(dyn_msg.contains("无法解析"), "{dyn_msg}");
    let brace_msg = denied_of(evaluate(&CommandPolicySpec::default(), "if ($true) { echo hi", "pwsh"));
    assert!(brace_msg.contains("无法解析"), "{brace_msg}");
}

#[test]
#[cfg(windows)]
fn deletion_rules_case_insensitive_on_windows() {
    assert_blocked("RM -R -F x", "递归强制删除");
    assert_blocked("CMD /C DEL /F x.txt", "强制删除");
}

// ── fail-closed ──────────────────────────────────────────────────────────────

#[test]
fn unclosed_quote_fails_closed() {
    assert_blocked("echo \"unclosed", "无法解析");
}

#[test]
fn dynamic_command_name_fails_closed() {
    // 字面哲学看不见动态命令名（opencode 的 dynamic-command-name 同款处理）：
    // 首词是变量时无法判定将要执行什么，按 fail-closed 拒绝
    assert_blocked("cmd=rm; $cmd -rf /tmp/example", "无法解析");
}

#[test]
fn wrapper_depth_overflow_fails_closed() {
    let command = "env env env env env env env env env rm -rf /tmp/example";
    assert_blocked(command, "嵌套过深");
}

#[test]
fn deep_substitution_overflow_fails_closed() {
    // 9 层 $() 嵌套，超过 8 层上限按 fail-closed 拒绝
    let mut command = "echo rm -rf /tmp".to_string();
    for _ in 0..9 {
        command = format!("echo $({command})");
    }
    assert_blocked(&command, "无法解析");
}

// ── 白名单 / 黑名单 ───────────────────────────────────────────────────────────

#[test]
fn deny_rule_blocks_and_reports_pattern() {
    let policy = spec(&["git *"], &["git push *"], OnUnmatched::Deny);
    let decision = evaluate(&policy, "git push origin dev", "git-bash");
    let message = denied_of(decision);
    assert!(message.contains("git push *"), "应说明命中的黑名单规则: {message}");
    assert!(message.contains("git push origin dev"), "应包含被拦命令: {message}");
}

#[test]
fn deny_wins_over_allow() {
    let policy = spec(&["git *"], &["git push *"], OnUnmatched::Allow);
    let decision = evaluate(&policy, "git push origin", "git-bash");
    assert!(matches!(decision, Decision::Deny(_)));
    // 未命中黑名单的白名单命令照常放行
    let decision = evaluate(&policy, "git status", "git-bash");
    assert!(matches!(decision, Decision::Allow));
}

#[test]
fn allow_unmatched_denied_by_default() {
    let policy = spec(&["echo *"], &[], OnUnmatched::Deny);
    let decision = evaluate(&policy, "pwd", "git-bash");
    let message = denied_of(decision);
    assert!(message.contains("白名单"), "应说明未命中白名单: {message}");
    assert!(message.contains("echo *"), "应列出可用前缀: {message}");
}

#[test]
fn allow_unmatched_allowed_when_configured() {
    let policy = spec(&["echo *"], &[], OnUnmatched::Allow);
    let decision = evaluate(&policy, "pwd", "git-bash");
    assert!(matches!(decision, Decision::Allow));
}

#[test]
fn empty_allow_means_no_whitelist() {
    let policy = spec(&[], &[], OnUnmatched::Deny);
    for command in ["curl https://example.com", "echo hi", "pwd"] {
        let decision = evaluate(&policy, command, "git-bash");
        assert!(matches!(decision, Decision::Allow), "{command} 不应被拦");
    }
}

#[test]
fn compound_command_each_segment_checked() {
    let policy = spec(&["echo *"], &[], OnUnmatched::Deny);
    let decision = evaluate(&policy, "echo hi && curl https://example.com", "git-bash");
    let message = denied_of(decision);
    assert!(message.contains("curl"), "应指出未命中的子命令: {message}");
}

#[test]
fn builtin_danger_overrides_allow() {
    let policy = spec(&["rm *"], &[], OnUnmatched::Allow);
    let decision = evaluate(&policy, "rm -rf /tmp/example", "git-bash");
    let message = denied_of(decision);
    assert!(message.contains("递归强制删除"), "内置表优先于白名单: {message}");
}

#[test]
#[cfg(windows)]
fn normalized_exec_hits_allow_pattern() {
    let policy = spec(&["git *"], &[], OnUnmatched::Deny);
    // 路径形式：POSIX 路径、正斜杠盘符路径、加引号的反斜杠路径（bash 里未加引号的
    // 反斜杠是转义符，真实命令不会出现未加引号的 C:\ 形态）
    for command in [
        "/mingw64/bin/git.exe status",
        "C:/Progra~1/Git/cmd/GIT.EXE status",
        r#""C:\Progra~1\Git\cmd\GIT.EXE" status"#,
    ] {
        let decision = evaluate(&policy, command, "git-bash");
        assert!(matches!(decision, Decision::Allow), "{command} 应命中白名单");
    }
}

#[test]
fn deny_pattern_with_position_semantics() {
    // 参数位置：`push git` 不命中 `git push *` 也不命中 `git *`? —— `git *` 命中一切 git 开头，
    // 这里用具体模式验证位置敏感：deny "git push *" 不拦 "push git origin"
    let policy = spec(&["*"], &["git push *"], OnUnmatched::Deny);
    let decision = evaluate(&policy, "push git origin", "git-bash");
    assert!(matches!(decision, Decision::Allow));
}

// ── 协议级：bash / job_start 请求带 policy 时闸门生效 ─────────────────────────

fn gated_line(op: &str, extra: serde_json::Value) -> String {
    let shell = serde_json::json!({ "kind": "git-bash", "program": "bash" });
    let mut body = serde_json::json!({
        "id": 9,
        "op": op,
        "command": "echo hello",
        "root": env!("CARGO_MANIFEST_DIR"),
        "cwd": env!("CARGO_MANIFEST_DIR"),
        "shell": shell,
    });
    if op == "bash" {
        body["timeout_ms"] = serde_json::json!(1000);
        body["max_output_bytes"] = serde_json::json!(1024);
    } else {
        body["max_output_bytes"] = serde_json::json!(1024);
    }
    body["policy"] = extra;
    body.to_string()
}

#[test]
fn bash_request_with_deny_policy_returns_rejection() {
    let policy = serde_json::json!({ "allow": [], "deny": ["echo *"], "onUnmatched": "deny" });
    let response = crate::handle_request(&gated_line("bash", policy));
    assert_eq!(response["ok"], serde_json::json!(false));
    let error = response["error"].as_str().expect("error 应为字符串");
    assert!(error.contains("echo *"), "拒绝话术应含命中规则: {error}");
}

#[test]
fn job_start_request_with_deny_policy_returns_rejection() {
    let policy = serde_json::json!({ "allow": [], "deny": ["echo *"], "onUnmatched": "deny" });
    let response = crate::handle_request(&gated_line("job_start", policy));
    assert_eq!(response["ok"], serde_json::json!(false));
    let error = response["error"].as_str().expect("error 应为字符串");
    assert!(error.contains("echo *"), "拒绝话术应含命中规则: {error}");
}

#[test]
fn bash_request_builtin_dangerous_without_policy() {
    // 不带 policy 字段时内置危险表仍然生效
    let shell = serde_json::json!({ "kind": "git-bash", "program": "bash" });
    let line = serde_json::json!({
        "id": 10,
        "op": "bash",
        "command": "rm -rf /tmp/example",
        "root": env!("CARGO_MANIFEST_DIR"),
        "cwd": env!("CARGO_MANIFEST_DIR"),
        "timeout_ms": 1000,
        "max_output_bytes": 1024,
        "shell": shell,
    })
    .to_string();
    let response = crate::handle_request(&line);
    assert_eq!(response["ok"], serde_json::json!(false));
    let error = response["error"].as_str().expect("error 应为字符串");
    assert!(error.contains("递归强制删除"), "{error}");
}
