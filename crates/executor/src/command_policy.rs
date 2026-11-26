//! 命令闸门：bash / job_start 执行前的策略检查，拦截发生在 spawn 之前。
//!
//! 三层判定，顺序固定：
//! 1. 内置危险表（兜底 deny，不依赖用户配置）
//! 2. 黑名单（config deny 模式，命中即拒绝并说明规则）
//! 3. 白名单（config allow 模式，非空时未命中的子命令按 onUnmatched 处理，默认拒绝）
//!
//! 命令先拆成简单命令段再逐段判定：顶层运算符（`;` `\n` `&&` `||` `|` `&`）切段、
//! 子 shell `( ... )` 与 `$()`/反引号/进程替换内部递归检查、花括号组与控制流前导词剥离、
//! sudo/env 前导剥离、`VAR=value` 赋值剥离、trap 的 action 当 shell 源码递归。
//! 引号/括号不闭合或命令名是变量时按 fail-closed 拒绝。
//!
//! 已知局限（与 codex 的字面匹配哲学一致）：字面量判定看不见动态展开后的命令内容，
//! 动态命令名（首词含 `$`）一律 fail-closed；复杂数据流（管道输入喂给 rm 等）不在字面判定范围内。
//!
//! 复用来源（见票 08 与 NOTICE）：
//! - 通配匹配：opencode `packages/core/src/util/wildcard.ts`（MIT）零依赖改写
//! - 可执行名归一化：codex `shell-command/src/command_safety` 的 `executable_name_lookup_key` 形状
//! - 危险规则表：codex `command_safety/is_dangerous_command.rs` 与 `windows_dangerous_commands.rs`
//!   的 rm 谓词、cmd/PowerShell 删除类规则；format/diskpart/reg delete 为自写（codex 无对应规则）

use serde::Deserialize;

/// wrapper/替换体递归深度上限，超限按 fail-closed 拒绝（codex 同款上限）。
const MAX_WRAPPER_DEPTH: usize = 8;

/// 命令策略（来自 config.json 的 commandPolicy，TS 侧原样透传进 bash/job_start 请求）。
#[derive(Debug, Default, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CommandPolicySpec {
    /// 白名单：通配模式（如 "git push *"），非空时启用白名单
    pub allow: Vec<String>,
    /// 黑名单：通配模式，任一子命令命中即拒绝
    pub deny: Vec<String>,
    /// 白名单非空且子命令未命中时的处理
    pub on_unmatched: OnUnmatched,
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OnUnmatched {
    #[default]
    Deny,
    Allow,
}

/// 闸门判定结果。Deny 携带写给模型看的完整话术（被拦命令、命中规则、替代方案）。
#[derive(Debug, PartialEq, Eq)]
pub enum Decision {
    Allow,
    Deny(String),
}

/// 一条简单命令段：wrapper/赋值剥离后的词序列（首词是待执行的可执行名）。
struct Segment {
    words: Vec<String>,
}

// ── 通配匹配 ─────────────────────────────────────────────────────────────────

/// opencode util/wildcard.ts 的零依赖 Rust 移植。
/// `*` 匹配任意序列（含空格与空串）、`?` 匹配单个字符、其余字面量；
/// `\` 在两侧统一归一成 `/`；Windows 上 ASCII 大小写折叠。
/// 模式以 " *" 结尾时，裸前缀（无参数）也命中——对应 opencode 的 `" *" → "( .*)?"` 特例。
pub fn wildcard_match(text: &str, pattern: &str) -> bool {
    let normalize = |s: &str| -> Vec<char> {
        let s = s.replace('\\', "/");
        if cfg!(windows) {
            s.chars().map(|c| c.to_ascii_lowercase()).collect()
        } else {
            s.chars().collect()
        }
    };
    let text = normalize(text);
    let pattern = normalize(pattern);
    // 末尾 " *" 拆成两个候选：裸前缀（无参数）与完整模式（带参数）
    if pattern.len() >= 2 && pattern[pattern.len() - 2] == ' ' && pattern[pattern.len() - 1] == '*' {
        let prefix = &pattern[..pattern.len() - 2];
        return match_wildcard(&text, prefix) || match_wildcard(&text, &pattern);
    }
    match_wildcard(&text, &pattern)
}

/// 经典单回溯通配匹配（贪心推进，失配回退到最后一个 `*` 的消费点）。
fn match_wildcard(text: &[char], pattern: &[char]) -> bool {
    let (mut ti, mut pi) = (0usize, 0usize);
    let mut star_pi: Option<usize> = None;
    let mut star_ti = 0usize;
    while ti < text.len() {
        if pi < pattern.len() && (pattern[pi] == '?' || pattern[pi] == text[ti]) {
            ti += 1;
            pi += 1;
        } else if pi < pattern.len() && pattern[pi] == '*' {
            star_pi = Some(pi);
            star_ti = ti;
            pi += 1;
        } else if let Some(sp) = star_pi {
            pi = sp + 1;
            star_ti += 1;
            ti = star_ti;
        } else {
            return false;
        }
    }
    while pi < pattern.len() && pattern[pi] == '*' {
        pi += 1;
    }
    pi == pattern.len()
}

// ── 可执行名归一化 ───────────────────────────────────────────────────────────

/// 可执行名归一化（borrowed from codex shell-command/src/command_safety，
/// `executable_name_lookup_key` 的 Windows 分支形状）：
/// 剥路径与盘符 → ASCII 小写 → 去 `.exe/.cmd/.bat/.com` 后缀。
pub fn executable_lookup_key(raw: &str) -> Option<String> {
    #[cfg(windows)]
    {
        let name = raw.rsplit(['/', '\\']).next().filter(|name| !name.is_empty())?;
        let name = match name.as_bytes() {
            [drive, b':', ..] if drive.is_ascii_alphabetic() => &name[2..],
            _ => name,
        };
        let name = name.to_ascii_lowercase();
        for suffix in [".exe", ".cmd", ".bat", ".com"] {
            if let Some(stripped) = name.strip_suffix(suffix) {
                return (!stripped.is_empty()).then(|| stripped.to_string());
            }
        }
        (!name.is_empty()).then_some(name)
    }

    #[cfg(not(windows))]
    {
        let name = raw.rsplit('/').next().filter(|name| !name.is_empty())?;
        Some(name.to_string())
    }
}

// ── 命令拆分 ─────────────────────────────────────────────────────────────────

#[derive(Clone, Copy, PartialEq, Eq)]
enum ShellKind {
    GitBash,
    Pwsh,
    Other,
}

impl ShellKind {
    fn parse(raw: &str) -> Self {
        match raw {
            "git-bash" => Self::GitBash,
            "pwsh" => Self::Pwsh,
            _ => Self::Other,
        }
    }
}

struct SegmentCollector<'a> {
    shell: ShellKind,
    out: &'a mut Vec<Segment>,
}

impl<'a> SegmentCollector<'a> {
    /// 引号感知地把命令文本拆成简单命令段。
    /// `Err(reason)` 表示解析失败（引号/括号未闭合、动态命令名、嵌套过深），fail-closed。
    fn collect_segments(&mut self, text: &str, depth: usize) -> Result<(), String> {
        if depth > MAX_WRAPPER_DEPTH {
            return Err("wrapper 或替换体嵌套过深（超过 8 层）".to_string());
        }
        let chars: Vec<char> = text.chars().collect();
        let mut current = String::new();
        let mut i = 0usize;
        while i < chars.len() {
            if let Some(next) = self.step_quoted_or_substitution(&chars, i, depth)? {
                current.extend(&chars[i..next]);
                i = next;
                continue;
            }
            match chars[i] {
                '(' => {
                    let (body, end) = extract_delimited(&chars, i + 1, '(', ')', "括号未闭合")?;
                    if self.shell != ShellKind::Pwsh && is_trailing_array_assignment(&current) {
                        // bash 数组赋值 VAR=(a b $(cmd))：元素本身不是命令，只递归扫描内部的命令替换
                        let before_last = current
                            .trim_end()
                            .rsplit_once(char::is_whitespace)
                            .map(|(head, _)| head)
                            .unwrap_or("");
                        self.flush_segment(before_last, depth)?;
                        current.clear();
                        self.collect_substitutions(&body, depth + 1)?;
                    } else if self.shell == ShellKind::Pwsh && is_pwsh_condition_header(&current) {
                        // pwsh 控制流条件 `if ($true)` / `while ($x -lt 1)`：剥除控制流头，
                        // 先扫内部替换，若条件首词像命令字面量（如 `if (rm -Force x)`）也按命令段检查
                        current.clear();
                        self.collect_substitutions(&body, depth + 1)?;
                        if pwsh_condition_looks_like_command(&body) {
                            self.collect_segments(&body, depth + 1)?;
                        }
                    } else if self.shell == ShellKind::Pwsh && !current.trim().is_empty() {
                        // pwsh 非段首括号子表达式（如 `echo (git push ...)` 或 `$x = (curl ...)`）：
                        // 括号内管道会直接执行，必须递归按命令段检查；外层用字面占位保留主命令匹配
                        if is_pwsh_var_assignment_prefix(&current) {
                            current.clear();
                        } else {
                            current.push_str("__subexpr__");
                        }
                        self.collect_segments(&body, depth + 1)?;
                    } else {
                        // git-bash 任意未引号 '('（子 shell / 函数头）与 pwsh 段首 '(...)'
                        self.flush_segment(&current, depth)?;
                        current.clear();
                        self.collect_segments(&body, depth + 1)?;
                    }
                    i = end;
                }
                ')' => return Err("括号未闭合".to_string()),
                '{' if self.shell == ShellKind::Pwsh => {
                    // pwsh 脚本块 `{ ... }`（含 `if (...) { ... }`、`& { ... }`、`. { ... }`、`ForEach-Object { ... }`）
                    let before_block = strip_pwsh_block_prefix(&current);
                    self.flush_segment(before_block, depth)?;
                    current.clear();
                    let (body, end) = extract_delimited(&chars, i + 1, '{', '}', "花括号未闭合")?;
                    self.collect_segments(&body, depth + 1)?;
                    i = end;
                }
                '}' if self.shell == ShellKind::Pwsh => {
                    return Err("花括号未闭合".to_string());
                }
                '&' | '|' | ';' | '\n' if is_separator(&chars, i) => {
                    self.flush_segment(&current, depth)?;
                    current.clear();
                    i = separator_end(&chars, i);
                }
                ch => {
                    current.push(ch);
                    i += 1;
                }
            }
        }
        self.flush_segment(&current, depth)?;
        Ok(())
    }

    /// 扫描非命令上下文（如数组字面量或纯变量条件括号）中潜藏的 `$(...)` / 反引号 / 进程替换。
    fn collect_substitutions(&mut self, text: &str, depth: usize) -> Result<(), String> {
        if depth > MAX_WRAPPER_DEPTH {
            return Err("wrapper 或替换体嵌套过深（超过 8 层）".to_string());
        }
        let chars: Vec<char> = text.chars().collect();
        let mut i = 0usize;
        while i < chars.len() {
            if let Some(next) = self.step_quoted_or_substitution(&chars, i, depth)? {
                i = next;
            } else {
                i += 1;
            }
        }
        Ok(())
    }

    /// 共用词法步进：处理转义、单/双引号（含双引号内替换）以及未引号的 `$()` / 反引号 / `<()`。
    /// 命中时递归收集内部替换体并返回消费后的新下标；未命中返回 `Ok(None)`。
    fn step_quoted_or_substitution(
        &mut self,
        chars: &[char],
        i: usize,
        depth: usize,
    ) -> Result<Option<usize>, String> {
        match chars[i] {
            '\'' => {
                let end = find_closing(chars, i + 1, '\'')?;
                Ok(Some(end + 1))
            }
            '"' => {
                let mut j = i + 1;
                let mut closed = false;
                while j < chars.len() {
                    match chars[j] {
                        '\\' if j + 1 < chars.len() => j += 2,
                        '"' => {
                            closed = true;
                            break;
                        }
                        '$' if j + 1 < chars.len() && chars[j + 1] == '(' => {
                            let (body, end) =
                                extract_delimited(chars, j + 2, '(', ')', "括号未闭合")?;
                            self.collect_segments(&body, depth + 1)?;
                            j = end;
                        }
                        '`' if self.shell != ShellKind::Pwsh => {
                            let (body, end) = extract_backtick(chars, j + 1)?;
                            self.collect_segments(&body, depth + 1)?;
                            j = end;
                        }
                        _ => j += 1,
                    }
                }
                if !closed {
                    return Err("引号未闭合".to_string());
                }
                Ok(Some(j + 1))
            }
            '\\' if i + 1 < chars.len() => Ok(Some(i + 2)),
            '$' if i + 1 < chars.len() && chars[i + 1] == '(' => {
                let (body, end) = extract_delimited(chars, i + 2, '(', ')', "括号未闭合")?;
                self.collect_segments(&body, depth + 1)?;
                Ok(Some(end))
            }
            '`' if self.shell != ShellKind::Pwsh => {
                let (body, end) = extract_backtick(chars, i + 1)?;
                self.collect_segments(&body, depth + 1)?;
                Ok(Some(end))
            }
            '<' | '>' if i + 1 < chars.len() && chars[i + 1] == '(' => {
                let (body, end) = extract_delimited(chars, i + 2, '(', ')', "括号未闭合")?;
                self.collect_segments(&body, depth + 1)?;
                Ok(Some(end))
            }
            _ => Ok(None),
        }
    }

    /// 处理一个顶层片段：shlex 分词 → wrapper/控制流前导词剥离 → 动态命令名检查 → 收集。
    fn flush_segment(&mut self, piece: &str, depth: usize) -> Result<(), String> {
        let trimmed = piece.trim();
        if trimmed.is_empty() {
            return Ok(());
        }
        let words = shlex::split(trimmed).ok_or_else(|| "引号未闭合".to_string())?;
        if words.is_empty() {
            return Ok(());
        }
        let words = self.strip_wrappers(words, depth)?;

        // trap 的 action 是 shell 源码，递归检查后再继续判定剩余词
        if words.first().map(|w| w == "trap").unwrap_or(false) {
            let mut idx = 1;
            if words.get(idx).map(|w| w == "--").unwrap_or(false) {
                idx += 1;
            }
            if let Some(action) = words.get(idx).filter(|w| !w.starts_with('-')) {
                self.collect_segments(action, depth + 1)?;
            }
        }

        let Some(first) = words.first() else {
            return Ok(());
        };
        if first.contains('$') || first.contains('`') {
            return Err(format!("命令名含变量或命令替换（{first}），无法判定将要执行什么"));
        }
        self.out.push(Segment { words });
        Ok(())
    }

    /// 剥离 sudo / env wrapper 及各 shell 的花括号组与控制流前导关键字（深度计数防炸）。
    fn strip_wrappers(&self, words: Vec<String>, depth: usize) -> Result<Vec<String>, String> {
        if depth > MAX_WRAPPER_DEPTH {
            return Err("wrapper 嵌套过深（超过 8 层）".to_string());
        }
        let mut words = strip_assignments(words);
        if self.shell == ShellKind::Pwsh {
            loop {
                let Some(head) = words.first().map(String::as_str) else {
                    return Ok(words);
                };
                if head.eq_ignore_ascii_case("else")
                    || head.eq_ignore_ascii_case("try")
                    || head.eq_ignore_ascii_case("finally")
                    || head.eq_ignore_ascii_case("do")
                    || (head == "." && words.len() > 1)
                {
                    words.remove(0);
                } else {
                    break;
                }
            }
        } else {
            // 花括号组与控制流关键字不消耗 wrapper 递归预算，循环剥离紧随其后的真实子命令
            loop {
                while matches!(words.last().map(String::as_str), Some("}")) && words.len() == 1 {
                    words.pop();
                }
                let Some(head) = words.first().map(String::as_str) else {
                    return Ok(words);
                };
                match head {
                    "}" | "fi" | "done" | "esac" if words.len() == 1 => {
                        words.clear();
                        return Ok(words);
                    }
                    "{" | "then" | "else" | "do" | "if" | "elif" | "while" | "until" | "!" => {
                        words.remove(0);
                        words = strip_assignments(words);
                    }
                    "time" => {
                        words.remove(0);
                        while matches!(words.first().map(String::as_str), Some("-p" | "--")) {
                            words.remove(0);
                        }
                        words = strip_assignments(words);
                    }
                    _ => break,
                }
            }
        }
        let Some(first) = words.first().cloned() else {
            return Ok(words);
        };
        match first.as_str() {
            "sudo" => self.strip_wrappers(words[1..].to_vec(), depth + 1),
            "env" => {
                let mut rest = words[1..].to_vec();
                while let Some(arg) = rest.first().cloned() {
                    if arg == "-i" || arg == "--ignore-environment" || is_assignment(&arg) {
                        rest.remove(0);
                    } else if arg == "--" {
                        rest.remove(0);
                        break;
                    } else {
                        break;
                    }
                }
                self.strip_wrappers(rest, depth + 1)
            }
            _ => Ok(words),
        }
    }
}

/// 判断 `'('` 紧邻的前缀末尾是否是 `VAR=` 形态的数组赋值头。
fn is_trailing_array_assignment(prefix: &str) -> bool {
    if !prefix.ends_with('=') {
        return false;
    }
    let last_token = prefix.rsplit(char::is_whitespace).next().unwrap_or("");
    is_assignment(last_token)
}

/// 判断 pwsh 中紧邻 `'('` 之前的前缀是否为控制流条件头（如 `if` / `elseif` / `while` / `switch`）。
fn is_pwsh_condition_header(prefix: &str) -> bool {
    let mut tokens = prefix.split_whitespace().peekable();
    while let Some(&tok) = tokens.peek() {
        if tok.eq_ignore_ascii_case("else") || tok.eq_ignore_ascii_case("do") {
            tokens.next();
        } else {
            break;
        }
    }
    let rest: Vec<&str> = tokens.collect();
    matches!(rest.as_slice(), [kw] if matches!(
        kw.to_ascii_lowercase().as_str(),
        "if" | "elseif" | "while" | "until" | "switch" | "for" | "foreach"
    ))
}

/// 判断 pwsh 条件括号体是否以字面命令而非纯变量/字面量表达式开头（如 `if (rm -Force x)`）。
fn pwsh_condition_looks_like_command(body: &str) -> bool {
    let trimmed = body.trim_start().trim_start_matches('!').trim_start();
    let Some(first_ch) = trimmed.chars().next() else {
        return false;
    };
    !matches!(first_ch, '$' | '\'' | '"' | '(' | '@' | '[' | '-' | '0'..='9')
}

/// 判断 pwsh 中紧邻 `'('` 之前是否为 `$var =` 赋值前缀。
fn is_pwsh_var_assignment_prefix(prefix: &str) -> bool {
    let Some(lhs) = prefix.trim_end().strip_suffix('=') else {
        return false;
    };
    let lhs = lhs.trim();
    lhs.starts_with('$') && !lhs.chars().any(char::is_whitespace)
}

/// 剥离 pwsh `{ ... }` 脚本块之前的控制流关键字与 `.` 调用算子，保留真实前置命令（如 `ForEach-Object`）。
fn strip_pwsh_block_prefix(prefix: &str) -> &str {
    let mut rest = prefix.trim();
    loop {
        if let Some(after_dot) = rest.strip_prefix('.')
            && (after_dot.is_empty() || after_dot.starts_with(char::is_whitespace))
        {
            rest = after_dot.trim_start();
            continue;
        }
        let first_end = rest.find(char::is_whitespace).unwrap_or(rest.len());
        let first = &rest[..first_end];
        if matches!(
            first.to_ascii_lowercase().as_str(),
            "else" | "try" | "finally" | "do" | "begin" | "process" | "end"
        ) {
            rest = rest[first_end..].trim_start();
        } else {
            break;
        }
    }
    rest
}

/// 判断 chars[i] 处的 `&`/`|`/`;`/`\n` 是否是命令分隔符：
/// `&&`/`||` 是；`&>`、`>&`、`|&` 的黏连形态不是纯分隔或按分隔处理（`|&` 切在 `|`）。
fn is_separator(chars: &[char], i: usize) -> bool {
    let c = chars[i];
    match c {
        ';' | '\n' => true,
        '&' => {
            let next = chars.get(i + 1).copied();
            let prev = if i > 0 { Some(chars[i - 1]) } else { None };
            // &> 与 >& 是重定向，不是分隔符
            if next == Some('>') || prev == Some('>') {
                return false;
            }
            true
        }
        '|' => true,
        _ => false,
    }
}

/// 分隔符消费长度：`&&`/`||` 占两字符，其余一字符。
fn separator_end(chars: &[char], i: usize) -> usize {
    if matches!(chars[i], '&' | '|') && chars.get(i + 1) == Some(&chars[i]) {
        i + 2
    } else {
        i + 1
    }
}

/// 从 from 开始找配对的闭引号，找不到报未闭合。
fn find_closing(chars: &[char], from: usize, quote: char) -> Result<usize, String> {
    let mut j = from;
    while j < chars.len() {
        if quote == '"' && chars[j] == '\\' {
            j += 2;
            continue;
        }
        if chars[j] == quote {
            return Ok(j);
        }
        j += 1;
    }
    Err("引号未闭合".to_string())
}

/// 提取成对定界符体（`( ... )` 或 `{ ... }`）：配对扫描，跳过转义与引号内定界符。
/// 返回 (体文本, 右定界符之后的位置)。
fn extract_delimited(
    chars: &[char],
    from: usize,
    open: char,
    close: char,
    unclosed_reason: &'static str,
) -> Result<(String, usize), String> {
    let mut depth = 1usize;
    let mut j = from;
    while j < chars.len() {
        match chars[j] {
            '\\' if j + 1 < chars.len() => {
                j += 2;
            }
            '\'' => {
                let end = find_closing(chars, j + 1, '\'')?;
                j = end + 1;
            }
            '"' => {
                let end = find_closing(chars, j + 1, '"')?;
                j = end + 1;
            }
            ch if ch == open => {
                depth += 1;
                j += 1;
            }
            ch if ch == close => {
                depth -= 1;
                if depth == 0 {
                    return Ok((chars[from..j].iter().collect(), j + 1));
                }
                j += 1;
            }
            _ => j += 1,
        }
    }
    Err(unclosed_reason.to_string())
}

/// 提取反引号替换体。返回 (体文本, 反引号之后的位置)。
fn extract_backtick(chars: &[char], from: usize) -> Result<(String, usize), String> {
    let mut j = from;
    while j < chars.len() {
        if chars[j] == '\\' && j + 1 < chars.len() {
            j += 2;
            continue;
        }
        if chars[j] == '`' {
            return Ok((chars[from..j].iter().collect(), j + 1));
        }
        j += 1;
    }
    Err("反引号未闭合".to_string())
}

/// 剥离前导 `VAR=value` 赋值。
fn strip_assignments(mut words: Vec<String>) -> Vec<String> {
    while let Some(first) = words.first() {
        if is_assignment(first) {
            words.remove(0);
        } else {
            break;
        }
    }
    words
}

fn is_assignment(word: &str) -> bool {
    let Some(eq) = word.find('=') else {
        return false;
    };
    let name = &word[..eq];
    !name.is_empty()
        && name.starts_with(|c: char| c.is_ascii_alphabetic() || c == '_')
        && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
}

// ── 内置危险表 ───────────────────────────────────────────────────────────────

/// 内置危险规则判定（兜底 deny，不依赖用户配置）。
/// shell 是本请求的 shell（GitBash | Pwsh），决定 PowerShell 规则的适用面；
/// cmd.exe / pwsh 显式包裹的规则在任何 shell 下都生效。
fn builtin_danger(words: &[String], shell: ShellKind) -> Option<(&'static str, &'static str, &'static str)> {
    let first = words.first()?;
    let exec = executable_lookup_key(first).unwrap_or_else(|| first.clone());
    match exec.as_str() {
        "rm" if shell == ShellKind::GitBash
            && rm_has_flag(&words[1..], &['r', 'R'], "--recursive")
            && rm_has_flag(&words[1..], &['f'], "--force") => {
            Some((
                "递归强制删除",
                "rm 同时带递归与强制标记，会不可恢复地删除整棵目录树，且不经过任何确认。",
                "改为逐个文件或子目录删除（不带 -f），或分步执行；确需整体清空目录树时，请让用户本人在沙箱外手动执行。",
            ))
        }
        "format" => Some((
            "磁盘格式化",
            "format 会格式化磁盘卷，数据不可恢复。",
            "沙箱内没有合法的格式化场景；如确需操作磁盘，请让用户本人手动执行。",
        )),
        "diskpart" => Some((
            "磁盘分区操作",
            "diskpart 可以清空/重写磁盘分区（clean 等），数据不可恢复。",
            "沙箱内没有合法的分区操作场景；如确需操作磁盘，请让用户本人手动执行。",
        )),
        "reg" if words.get(1).map(|w| w.eq_ignore_ascii_case("delete")).unwrap_or(false) => Some((
            "注册表批量删除",
            "reg delete 会不可恢复地删除注册表键值，且注册表位于沙箱之外。",
            "如确需清理注册表项，请让用户本人手动执行。",
        )),
        "cmd" => {
            let (rule, why, alt) = cmd_internal_danger(words)?;
            Some((rule, why, alt))
        }
        "pwsh" | "powershell" => {
            let (rule, why, alt) = powershell_wrapper_danger(words)?;
            Some((rule, why, alt))
        }
        _ if shell == ShellKind::Pwsh => {
            let (rule, why, alt) = powershell_force_delete(words)?;
            Some((rule, why, alt))
        }
        _ => None,
    }
}

/// rm 参数扫描（照 codex rm_args_include_force_option 的形态扩展）：
/// 扫描 `--` 之前的全部参数，组合短 flag（如 -rf）与长选项都识别。
fn rm_has_flag(args: &[String], short_chars: &[char], long: &str) -> bool {
    args.iter()
        .take_while(|arg| arg.as_str() != "--")
        .any(|arg| {
            arg.eq_ignore_ascii_case(long)
                || (arg.starts_with('-')
                    && !arg.starts_with("--")
                    && arg[1..]
                        .chars()
                        .any(|c| short_chars.iter().any(|s| s.eq_ignore_ascii_case(&c))))
        })
}

/// cmd /c 内部的删除类规则（照 codex is_dangerous_cmd 的结构）。
fn cmd_internal_danger(words: &[String]) -> Option<(&'static str, &'static str, &'static str)> {
    let mut iter = words[1..].iter();
    for arg in iter.by_ref() {
        let lower = arg.to_ascii_lowercase();
        match lower.as_str() {
            "/c" | "/r" | "-c" => break,
            _ if lower.starts_with('/') => continue,
            // /c 之前的未知 token：结构不明，放弃判定
            _ => return None,
        }
    }
    let rest: Vec<String> = iter.cloned().collect();
    if rest.is_empty() {
        return None;
    }
    let mut tokens: Vec<String> = match rest.as_slice() {
        [only] => shlex::split(only).unwrap_or_else(|| vec![only.clone()]),
        _ => rest.clone(),
    };
    tokens = tokens.iter().flat_map(|t| split_embedded_cmd_operators(t)).collect();

    const SEPARATORS: [&str; 4] = ["&", "&&", "|", "||"];
    for segment in tokens.split(|t| SEPARATORS.contains(&t.as_str())) {
        let Some(cmd) = segment.first() else {
            continue;
        };
        let Some(exec) = executable_lookup_key(cmd) else {
            continue;
        };
        let has_flag = |flag: &str| segment[1..].iter().any(|a| a.eq_ignore_ascii_case(flag));
        if matches!(exec.as_str(), "del" | "erase") && has_flag("/f") {
            return Some((
                "强制删除文件",
                "cmd del/erase 带 /f 会无确认强制删除文件。",
                "去掉 /f 改为常规删除，或逐个文件处理；确需批量强制删除请让用户本人执行。",
            ));
        }
        if matches!(exec.as_str(), "rd" | "rmdir") && has_flag("/s") && has_flag("/q") {
            return Some((
                "递归删除目录",
                "cmd rd/rmdir 带 /s /q 会无确认递归删除整棵目录树。",
                "逐层删除子项，或去掉 /s /q；确需整体删除目录树请让用户本人执行。",
            ));
        }
    }
    None
}

/// 切分黏连在 token 里的 CMD 运算符，如 `echo hi&del` → ["echo hi", "&", "del"]
/// （照 codex split_embedded_cmd_operators）。
fn split_embedded_cmd_operators(token: &str) -> Vec<String> {
    let mut parts = Vec::new();
    let mut start = 0usize;
    let chars: Vec<char> = token.chars().collect();
    let mut i = 0usize;
    while i < chars.len() {
        let ch = chars[i];
        if ch == '&' || ch == '|' {
            if i > start {
                parts.push(chars[start..i].iter().collect());
            }
            if chars.get(i + 1) == Some(&ch) {
                i += 1;
            }
            parts.push(ch.to_string());
            i += 1;
            start = i;
        } else {
            i += 1;
        }
    }
    if start < chars.len() {
        parts.push(chars[start..].iter().collect());
    }
    parts.retain(|s| !s.trim().is_empty());
    parts
}

/// 显式包一层 pwsh/powershell 时检查 -Command 的脚本内容
/// （照 codex parse_powershell_invocation 的形状做简化：取 -Command/-c 的下一个词）。
fn powershell_wrapper_danger(words: &[String]) -> Option<(&'static str, &'static str, &'static str)> {
    for (index, arg) in words[1..].iter().enumerate() {
        let lower = arg.to_ascii_lowercase();
        if matches!(lower.as_str(), "-command" | "/command" | "-c") {
            let script = words.get(index + 2)?;
            let tokens = shlex::split(script).unwrap_or_else(|| vec![script.clone()]);
            return powershell_force_delete(&tokens);
        }
    }
    None
}

const DELETE_CMDLETS: [&str; 7] = ["remove-item", "ri", "rm", "del", "erase", "rd", "rmdir"];

/// PowerShell 强制删除判定（照 codex has_force_delete_cmdlet 的分段启发式）：
/// 按硬分隔符（; | & 换行 tab）切段，段内按软分隔符（{}()[]）切原子，
/// 同一段内同时出现删除 cmdlet 与 -Force 才拦。
fn powershell_force_delete(words: &[String]) -> Option<(&'static str, &'static str, &'static str)> {
    const HARD_SEPARATORS: [char; 6] = [';', '|', '&', '\n', '\r', '\t'];
    const SOFT_SEPARATORS: [char; 6] = ['{', '}', '(', ')', '[', ']'];

    let tokens: Vec<String> = words
        .iter()
        .map(|t| t.trim_matches('\'').trim_matches('"').to_ascii_lowercase())
        .collect();

    let mut segments: Vec<Vec<String>> = vec![Vec::new()];
    for token in tokens {
        let mut current = String::new();
        for ch in token.chars() {
            if HARD_SEPARATORS.contains(&ch) {
                let piece = current.trim().to_string();
                if let Some(last) = segments.last_mut()
                    && !piece.is_empty()
                {
                    last.push(piece);
                }
                current.clear();
                if let Some(last) = segments.last()
                    && !last.is_empty()
                {
                    segments.push(Vec::new());
                }
            } else {
                current.push(ch);
            }
        }
        let piece = current.trim().to_string();
        if let Some(last) = segments.last_mut()
            && !piece.is_empty()
        {
            last.push(piece);
        }
    }

    for segment in segments {
        let atoms = segment.iter().flat_map(|token| {
            token
                .split(SOFT_SEPARATORS)
                .map(str::trim)
                .filter(|atom| !atom.is_empty())
        });
        let mut has_delete = false;
        let mut has_force = false;
        for atom in atoms {
            if DELETE_CMDLETS.contains(&atom) {
                has_delete = true;
            }
            if atom == "-force" || atom.starts_with("-force:") {
                has_force = true;
            }
        }
        if has_delete && has_force {
            return Some((
                "PowerShell 强制删除",
                "Remove-Item 系 cmdlet（含别名 rm/ri/del/rd）带 -Force 会无确认强制删除，配合 -Recurse 时整棵目录树不可恢复。",
                "去掉 -Force/-Recurse 改为逐项删除；确需强制递归删除请让用户本人在沙箱外手动执行。",
            ));
        }
    }
    None
}

// ── 判定主流程 ───────────────────────────────────────────────────────────────

/// 白/黑名单的匹配目标：首词做可执行名归一化，其余词原样，空格连接。
fn match_target(words: &[String]) -> String {
    let mut parts: Vec<String> = Vec::with_capacity(words.len());
    for (index, word) in words.iter().enumerate() {
        if index == 0 {
            parts.push(executable_lookup_key(word).unwrap_or_else(|| word.clone()));
        } else {
            parts.push(word.clone());
        }
    }
    parts.join(" ")
}

/// 拒绝话术里最多列出多少条白名单前缀，防止话术过长
const MAX_ALLOW_PATTERNS_SHOWN: usize = 8;

/// 闸门入口：对一条 shell 命令行做内置危险检查与白/黑名单判定。
/// shell_kind 为 "git-bash" 或 "pwsh"（与 ShellSpec.kind 一致）。
pub fn evaluate(spec: &CommandPolicySpec, command: &str, shell_kind: &str) -> Decision {
    let shell = ShellKind::parse(shell_kind);
    let mut segments: Vec<Segment> = Vec::new();
    let mut collector = SegmentCollector {
        shell,
        out: &mut segments,
    };
    if let Err(reason) = collector.collect_segments(command, 0) {
        return Decision::Deny(fail_closed_message(command, &reason));
    }

    // 1. 内置危险表：兜底 deny，优先于任何用户配置
    for segment in &segments {
        if let Some((rule, why, alternative)) = builtin_danger(&segment.words, shell) {
            return Decision::Deny(danger_message(command, rule, why, alternative));
        }
    }

    // 2. 黑名单：任一子命令命中任一模式即拒绝
    for segment in &segments {
        let target = match_target(&segment.words);
        for pattern in &spec.deny {
            if wildcard_match(&target, pattern) {
                return Decision::Deny(deny_message(command, pattern));
            }
        }
    }

    // 3. 白名单：非空时每条子命令都必须命中
    if !spec.allow.is_empty() {
        let mut unmatched: Option<String> = None;
        for segment in &segments {
            let target = match_target(&segment.words);
            if !spec.allow.iter().any(|pattern| wildcard_match(&target, pattern)) {
                unmatched = Some(target);
                break;
            }
        }
        if let Some(target) = unmatched {
            return match spec.on_unmatched {
                OnUnmatched::Deny => {
                    Decision::Deny(unmatched_message(command, &target, &spec.allow))
                }
                OnUnmatched::Allow => Decision::Allow,
            };
        }
    }

    Decision::Allow
}

/// 协议层闸门入口：放行返回 None；拒绝返回统一格式的协议错误响应（ok:false），
/// bash 与 job_start 共用，保证拒绝行为与话术一致。
pub fn gate(
    policy: Option<&CommandPolicySpec>,
    command: &str,
    shell_kind: &str,
    id: Option<u64>,
) -> Option<serde_json::Value> {
    let default_policy = CommandPolicySpec::default();
    match evaluate(policy.unwrap_or(&default_policy), command, shell_kind) {
        Decision::Allow => None,
        Decision::Deny(message) => Some(crate::error_response(id, message)),
    }
}

// ── 话术 ─────────────────────────────────────────────────────────────────────

fn fail_closed_message(command: &str, reason: &str) -> String {
    format!(
        "命令被命令策略拒绝: {command}\n\
         原因: 命令无法解析（{reason}）。闸门按 fail-closed 原则拒绝执行无法判定的命令。\n\
         替代方案: 检查引号、括号与反引号是否配对；不要用变量或命令替换拼接命令名，直接写命令字面量。"
    )
}

fn danger_message(command: &str, rule: &str, why: &str, alternative: &str) -> String {
    format!(
        "命令被命令策略拦截: {command}\n\
         命中规则: {rule}（内置危险命令拦截，不依赖用户配置）\n\
         原因: {why}\n\
         替代方案: {alternative}"
    )
}

fn deny_message(command: &str, pattern: &str) -> String {
    format!(
        "命令被命令策略拦截: {command}\n\
         命中规则: 黑名单模式 \"{pattern}\"（config.json 的 commandPolicy.deny）\n\
         替代方案: 如认为该命令应当放行，请让用户调整 config.json：从 commandPolicy.deny 移除该模式，或把更精确的安全前缀加入 commandPolicy.allow。"
    )
}

fn unmatched_message(command: &str, target: &str, allow: &[String]) -> String {
    let shown = allow.len().min(MAX_ALLOW_PATTERNS_SHOWN);
    let listed = allow[..shown].join("、");
    let more = if allow.len() > shown {
        format!("（另有 {} 条未列出）", allow.len() - shown)
    } else {
        String::new()
    };
    let first_word = target.split(' ').next().unwrap_or(target);
    format!(
        "命令被命令策略拦截: {command}\n\
         原因: 子命令 \"{target}\" 未命中白名单（config.json 的 commandPolicy.allow），按 onUnmatched=deny 拒绝。\n\
         可用白名单前缀: {listed}{more}\n\
         替代方案: 请让用户在 commandPolicy.allow 里加入对应前缀（例如 \"{first_word} *\"），或把 onUnmatched 改为 \"allow\"。"
    )
}

#[cfg(test)]
#[path = "command_policy_tests.rs"]
mod tests;
