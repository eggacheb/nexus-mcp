//! `edit` op 的匹配与替换算法。
//!
//! 移植自 opencode `packages/core/src/tool/plugin/edit.ts`（MIT），剥掉 Effect
//! 壳后是纯字符串函数：
//! - 三级匹配降级：精确 → Unicode 归一化（弯引号/弯破折号/各类空格）→ 行级尾空白匹配；
//! - CRLF 双向保真：在 LF 视图上匹配再映射回原偏移，替换行按 LCS 对齐继承原区域的行尾；
//! - missHint：匹配失败时按「忽略空白」的行投票定位最近区域，给出最多 12 行带行号提示。
//!
//! 决策记录（05 号票 Comments）：第三级保持 opencode 原样的 trimEnd——只容忍
//! 行尾空白，行首缩进必须一致；缩进对不上时靠 missHint 让模型看清真实缩进后重试。

use std::collections::{BTreeMap, HashMap};

/// 一次匹配在原文中的字节区间（恒为字符边界）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Match {
    pub start: usize,
    pub end: usize,
}

pub const CRLF: &str = "\r\n";

/// 单字符的 Unicode 归一化（1:1，与 opencode 一致）。
pub fn normalize_char(c: char) -> char {
    match c {
        '\u{2018}' | '\u{2019}' | '\u{201A}' | '\u{201B}' => '\'',
        '\u{201C}' | '\u{201D}' | '\u{201E}' | '\u{201F}' => '"',
        '\u{2010}'..='\u{2015}' | '\u{2212}' => '-',
        '\u{00A0}' | '\u{2002}'..='\u{200A}' | '\u{202F}' | '\u{205F}' | '\u{3000}' => ' ',
        _ => c,
    }
}

/// Unicode 归一化：弯引号、弯破折号、各类空格折算成 ASCII 等价物。
/// 模型从聊天管道带出的排版字符不该让精确匹配失败。
/// 注意：替换前后字节数可能不同，结果只用于整体比较，不能当偏移基底。
pub fn normalize_for_match(value: &str) -> String {
    value.chars().map(normalize_char).collect()
}

/// search 在 content 里全部不重叠出现的字节区间。
pub fn find_occurrences(content: &str, search: &str) -> Vec<Match> {
    if search.is_empty() {
        return Vec::new();
    }
    let mut result = Vec::new();
    let mut offset = 0;
    while let Some(found) = content[offset..].find(search) {
        let start = offset + found;
        let end = start + search.len();
        result.push(Match { start, end });
        offset = end;
    }
    result
}

/// `source_lines` 产出的一行：区间含行尾 `\n`（若有），`text` 不含。
struct SourceLine<'a> {
    start: usize,
    end: usize,
    text: &'a str,
    newline: bool,
    /// 行内容终点（去掉结尾 `\r`），用于不带尾 `\n` 的搜索
    content_end: usize,
}

/// 与 opencode 的正则 `[^\n]*(?:\n|$)` 一致地切行：每行带上自己的 `\n`，
/// 以 `\n` 结尾的内容不再产生末尾空行。
fn source_lines(content: &str) -> Vec<SourceLine<'_>> {
    let mut lines = Vec::new();
    let mut start = 0usize;
    for (index, ch) in content.char_indices() {
        if ch != '\n' {
            continue;
        }
        let end = index + 1;
        let text = &content[start..index];
        let trailing_cr = usize::from(text.ends_with('\r'));
        lines.push(SourceLine {
            start,
            end,
            text,
            newline: true,
            content_end: start + text.len() - trailing_cr,
        });
        start = end;
    }
    if start < content.len() {
        let text = &content[start..];
        let trailing_cr = usize::from(text.ends_with('\r'));
        lines.push(SourceLine {
            start,
            end: content.len(),
            text,
            newline: false,
            content_end: start + text.len() - trailing_cr,
        });
    }
    lines
}

/// 行级匹配（第三级）：search 按行拆开，在 content 里找连续窗口，
/// 每行「忽略行尾空白（及 Unicode 排版变体）」后逐行相等。
/// 行首缩进必须一致；search 是否以 `\n` 结尾也要对上。
pub fn find_line_occurrences(content: &str, search: &str) -> Vec<Match> {
    if search.is_empty() {
        return Vec::new();
    }
    let trailing_newline = search.ends_with('\n');
    let mut expected: Vec<&str> = search.split('\n').collect();
    if trailing_newline {
        expected.pop();
    }
    let lines = source_lines(content);
    let same = |a: &str, b: &str| normalize_for_match(a.trim_end()) == normalize_for_match(b.trim_end());
    let mut candidates = Vec::new();
    for index in 0..lines.len() {
        if index + expected.len() > lines.len() {
            break;
        }
        let window = &lines[index..index + expected.len()];
        if !window
            .iter()
            .zip(expected.iter())
            .all(|(line, want)| same(line.text, want))
        {
            continue;
        }
        let last = window.last().expect("窗口非空");
        if trailing_newline && !last.newline {
            continue;
        }
        let end = if trailing_newline { last.end } else { last.content_end };
        candidates.push(Match {
            start: window[0].start,
            end,
        });
    }
    // 与已保留候选重叠的丢弃（先到先得），与 opencode 一致
    let mut result: Vec<Match> = Vec::new();
    for candidate in candidates {
        if result
            .iter()
            .any(|m| m.end > candidate.start && m.start < candidate.end)
        {
            continue;
        }
        result.push(candidate);
    }
    result
}

/// Unicode 归一化层的匹配：按字符逐位比较（归一化不改字符数，字符下标在
/// content 与 search 之间一一对应），返回 content 字节坐标的匹配区间。
/// 不能用「归一化后 indexOf」——字节长度会变，偏移映射不回去。
pub fn find_normalized_occurrences(content: &str, search: &str) -> Vec<Match> {
    if search.is_empty() {
        return Vec::new();
    }
    let search_norm: Vec<char> = search.chars().map(normalize_char).collect();
    let content_chars: Vec<(usize, char)> = content.char_indices().collect();
    let mut result = Vec::new();
    for start in 0..content_chars.len() {
        // 廉价的首字符过滤，把整体代价压回接近 indexOf 的水平
        if normalize_char(content_chars[start].1) != search_norm[0] {
            continue;
        }
        if start + search_norm.len() > content_chars.len() {
            break;
        }
        if content_chars[start..start + search_norm.len()]
            .iter()
            .zip(search_norm.iter())
            .all(|((_, c), want)| normalize_char(*c) == *want)
        {
            let start_byte = content_chars[start].0;
            let end_byte = match content_chars.get(start + search_norm.len()) {
                Some(&(offset, _)) => offset,
                None => content.len(),
            };
            result.push(Match {
                start: start_byte,
                end: end_byte,
            });
        }
    }
    result
}

/// 文本中的主导行尾；没有任何行尾或两类一样多时返回 fallback。
pub fn line_ending<'a>(text: &str, fallback: &'a str) -> &'a str {
    let crlf_count = text.matches(CRLF).count();
    let lf_count = text.matches('\n').count() - crlf_count;
    if crlf_count == lf_count {
        return fallback;
    }
    if crlf_count > lf_count { CRLF } else { "\n" }
}

/// 按 `/\r?\n/` 切行（与 JS split 一致，包括首尾产生的空段）。
fn split_relaxed_lines(text: &str) -> Vec<&str> {
    let bytes = text.as_bytes();
    let mut parts = Vec::new();
    let mut start = 0usize;
    let mut i = 0usize;
    while i < bytes.len() {
        if bytes[i] == b'\n' {
            let mut end = i;
            if end > start && bytes[end - 1] == b'\r' {
                end -= 1;
            }
            parts.push(&text[start..end]);
            start = i + 1;
        }
        i += 1;
    }
    parts.push(&text[start..]);
    parts
}

/// 按出现顺序收集 `/\r?\n/` 的各处行尾文本。
fn collect_endings(text: &str) -> Vec<&str> {
    let bytes = text.as_bytes();
    let mut endings = Vec::new();
    let mut i = 0usize;
    while i < bytes.len() {
        if bytes[i] == b'\n' {
            if i > 0 && bytes[i - 1] == b'\r' {
                endings.push(&text[i - 1..i + 1]);
            } else {
                endings.push(&text[i..i + 1]);
            }
        }
        i += 1;
    }
    endings
}

/// 对齐表：对 after 的每一行给出它「沿用」的 before 行下标（LCS 命中，
/// 或夹在两个命中行之间时顶替的那一行）；没有对应时为 None。
pub fn align_lines(before: &[String], after: &[String]) -> Vec<Option<usize>> {
    let width = after.len() + 1;
    let mut table = vec![0u32; (before.len() + 1) * width];
    for i in (0..before.len()).rev() {
        for j in (0..after.len()).rev() {
            table[i * width + j] = if before[i] == after[j] {
                table[(i + 1) * width + j + 1] + 1
            } else {
                table[(i + 1) * width + j].max(table[i * width + j + 1])
            };
        }
    }
    let mut result: Vec<Option<usize>> = vec![None; after.len()];
    let mut gap_before: Vec<usize> = Vec::new();
    let mut gap_after: Vec<usize> = Vec::new();
    let flush = |result: &mut Vec<Option<usize>>,
                 gap_before: &mut Vec<usize>,
                 gap_after: &mut Vec<usize>| {
        for (k, &aj) in gap_after.iter().enumerate() {
            if let Some(&bi) = gap_before.get(k) {
                result[aj] = Some(bi);
            }
        }
        gap_before.clear();
        gap_after.clear();
    };
    let mut i = 0usize;
    let mut j = 0usize;
    while i < before.len() && j < after.len() {
        if before[i] == after[j] {
            flush(&mut result, &mut gap_before, &mut gap_after);
            result[j] = Some(i);
            i += 1;
            j += 1;
            continue;
        }
        if table[(i + 1) * width + j] >= table[i * width + j + 1] {
            gap_before.push(i);
            i += 1;
        } else {
            gap_after.push(j);
            j += 1;
        }
    }
    while i < before.len() {
        gap_before.push(i);
        i += 1;
    }
    while j < after.len() {
        gap_after.push(j);
        j += 1;
    }
    flush(&mut result, &mut gap_before, &mut gap_after);
    result
}

/// 把替换文本的行与原匹配区域的行尾对齐：LCS 命中的行沿用原行行尾；被改写的
/// 行沿用所替行的行尾；其余用 fallback。匹配区域内未改动的上下文逐字节保留，
/// 混合行尾文件不被污染。`replacement` 应为 LF 行（由调用方统一转换）。
pub fn with_region_endings(region: &str, replacement: &str, fallback: &str) -> String {
    let key = |line: &str| normalize_for_match(line.trim_end());
    let before: Vec<String> = split_relaxed_lines(region).iter().map(|l| key(l)).collect();
    let after: Vec<&str> = replacement.split('\n').collect();
    let after_keys: Vec<String> = after.iter().map(|l| key(l)).collect();
    let alignment = align_lines(&before, &after_keys);
    let endings = collect_endings(region);
    let mut out = String::new();
    let last = after.len().saturating_sub(1);
    for (index, line) in after.iter().enumerate() {
        out.push_str(line);
        if index == last {
            break;
        }
        let ending = match alignment[index] {
            Some(i) => endings.get(i).copied().unwrap_or(fallback),
            None => fallback,
        };
        out.push_str(ending);
    }
    out
}

/// 在 LF 视图上完成三级降级匹配，再把命中区间映射回原文字节偏移：
/// CRLF 与混合行尾既不妨碍匹配，也不会泄漏进未触碰的区域。
pub fn match_view(source: &str, old_string: &str) -> Vec<Match> {
    let view = source.replace(CRLF, "\n");
    // removed[k] = 第 k 个 \r\n 在 LF 视图里缩掉的字节数；视图偏移加上
    // 严格小于它的 removed 个数，就映射回原文偏移
    let removed: Vec<usize> = source
        .match_indices(CRLF)
        .enumerate()
        .map(|(k, (index, _))| index - k)
        .collect();
    let search = old_string.replace(CRLF, "\n");
    let exact = find_occurrences(&view, &search);
    let unicode = if exact.is_empty() {
        find_normalized_occurrences(&view, &search)
    } else {
        Vec::new()
    };
    let trailing = if exact.is_empty() && unicode.is_empty() {
        find_line_occurrences(&view, &search)
    } else {
        Vec::new()
    };
    let chosen = if !exact.is_empty() {
        exact
    } else if !unicode.is_empty() {
        unicode
    } else {
        trailing
    };
    chosen
        .into_iter()
        .map(|m| Match {
            start: m.start + count_before(&removed, m.start),
            end: m.end + count_before(&removed, m.end),
        })
        .collect()
}

/// 视图 → 原文偏移换算：统计严格小于 offset 的已移除位置数。
fn count_before(positions: &[usize], offset: usize) -> usize {
    positions.partition_point(|&p| p < offset)
}

/// 生成某个命中区间替换后的文本：行尾按原区域继承（LCS 对齐），
/// 继承不到的行用区域主导行尾，再退到文件主导行尾。
pub fn region_replacement(source: &str, matched: &Match, replacement_lf: &str) -> String {
    let region = &source[matched.start..matched.end];
    let file_ending = line_ending(source, "\n");
    with_region_endings(region, replacement_lf, line_ending(region, file_ending))
}

const HINT_LINES: usize = 12;
const HINT_LINE_LENGTH: usize = 200;

/// 匹配失败时的提示：要么 new_string 已在文件里（多半是编辑已应用过），
/// 要么按「忽略空白」的行投票定位与 old_string 最接近的区域，
/// 给出最多 12 行带行号（与 read 的行号一致）的摘录。
pub fn miss_hint(source: &str, old_string: &str, new_string: &str) -> Option<String> {
    let view = source.replace(CRLF, "\n");
    let replacement = new_string.replace(CRLF, "\n");
    if replacement.trim().chars().count() >= 20
        && normalize_for_match(&view).contains(&normalize_for_match(&replacement))
    {
        return Some("new_string 已经在文件里了，这次编辑可能已经应用过。".into());
    }
    let key = |line: &str| -> String {
        normalize_for_match(line)
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
    };
    // 只统计含字母或数字的行，纯符号/空行不参与投票
    let distinct = |line: &str| line.chars().any(char::is_alphanumeric);
    let lines: Vec<&str> = view.split('\n').collect();
    let search_text = old_string.replace(CRLF, "\n");
    let search: Vec<&str> = search_text.split('\n').collect();
    let mut positions: HashMap<String, Vec<usize>> = HashMap::new();
    for (index, line) in lines.iter().enumerate() {
        let value = key(line);
        if !distinct(&value) {
            continue;
        }
        positions.entry(value).or_default().push(index);
    }
    let mut votes: BTreeMap<isize, usize> = BTreeMap::new();
    let mut wanted = 0usize;
    for (offset, line) in search.iter().enumerate() {
        let value = key(line);
        if !distinct(&value) {
            continue;
        }
        wanted += 1;
        if let Some(found) = positions.get(&value) {
            for &index in found {
                *votes
                    .entry(index as isize - offset as isize)
                    .or_insert(0) += 1;
            }
        }
    }
    let best = votes
        .iter()
        .max_by_key(|(_, count)| *count)
        .map(|(&position, &count)| (position, count))
        .unwrap_or((0, 0));
    let (start, count) = best;
    // 至少一半搜索行在同一个起点上对齐，才值得给提示
    if count == 0 || count * 2 < wanted {
        return None;
    }
    let matched: Vec<usize> = search
        .iter()
        .enumerate()
        .filter_map(|(offset, line)| {
            let value = key(line);
            if value.is_empty() {
                return None;
            }
            let index = start + offset as isize;
            if index < 0 {
                return None;
            }
            let index = index as usize;
            if index < lines.len() && key(lines[index]) == value {
                Some(index)
            } else {
                None
            }
        })
        .collect();
    let from = *matched.first()?;
    let to = (matched.last().expect("matched 非空") + 1).min(from + HINT_LINES);
    let mut hint = String::from("文件里最接近的行：");
    for (k, line) in lines[from..to].iter().enumerate() {
        let number = from + k + 1;
        let display: String = if line.chars().count() > HINT_LINE_LENGTH {
            format!("{}…", line.chars().take(HINT_LINE_LENGTH).collect::<String>())
        } else {
            (*line).to_string()
        };
        hint.push_str(&format!("\n{number}: {display}"));
    }
    Some(hint)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_folds_typographic_variants() {
        assert_eq!(normalize_for_match("\u{2018}\u{201C}\u{2014}\u{00A0}"), "'\"- ");
        assert_eq!(normalize_for_match("普通 ascii 不变"), "普通 ascii 不变");
    }

    #[test]
    fn find_occurrences_unique_multi_and_none() {
        let content = "x\nx\naxb";
        assert_eq!(find_occurrences(content, "x").len(), 3);
        assert_eq!(find_occurrences(content, "axb").len(), 1);
        assert!(find_occurrences(content, "zzz").is_empty());
    }

    #[test]
    fn match_view_exact_unique_maps_back_through_crlf() {
        let source = "第一行\r\nsecond\r\nthird\r\n";
        let matches = match_view(source, "second");
        assert_eq!(matches.len(), 1);
        let m = matches[0];
        assert_eq!(&source[m.start..m.end], "second");
    }

    #[test]
    fn match_view_counts_multiple_matches() {
        let source = "a\nb\na\nb\n";
        let matches = match_view(source, "a\nb");
        assert_eq!(matches.len(), 2);
        for m in &matches {
            assert_eq!(&source[m.start..m.end], "a\nb");
        }
    }

    #[test]
    fn match_view_none_stays_empty() {
        assert!(match_view("a\nb\n", "zzz").is_empty());
    }

    #[test]
    fn match_view_tolerates_trailing_whitespace_per_line() {
        let source = "let a = 1;   \nlet b = 2;\t\n";
        let matches = match_view(source, "let a = 1;\nlet b = 2;");
        assert_eq!(matches.len(), 1);
        let m = matches[0];
        // 命中区域覆盖原文整行（含行尾空白）
        assert_eq!(&source[m.start..m.end], "let a = 1;   \nlet b = 2;\t");
    }

    #[test]
    fn match_view_line_tier_requires_exact_indentation_like_opencode() {
        // 决策：照搬 opencode——行级模糊匹配逐行比较保留行首缩进，
        // 多行块缩进不同就匹配不上；单行子串搜到行中则是精确层本来的行为
        let source = "fn a() {\n        body();\n}\n";
        let search = "fn a() {\n    body();\n}";
        assert!(match_view(source, search).is_empty());
        // 同内容同缩进则命中
        assert_eq!(
            match_view(source, "fn a() {\n        body();\n}").len(),
            1
        );
    }

    #[test]
    fn match_view_exact_tier_matches_mid_line_substring() {
        // 单行 old_string 是子串搜索，会命中缩进内部的同文片段（与 opencode 一致）
        let matches = match_view("    return x;\n", "return x;");
        assert_eq!(matches.len(), 1);
        let m = matches[0];
        assert_eq!(&"    return x;\n"[m.start..m.end], "return x;");
    }

    #[test]
    fn match_view_falls_back_to_unicode_normalization() {
        let source = "let s = \u{201C}你好\u{201D};\n";
        let matches = match_view(source, "let s = \"你好\";");
        assert_eq!(matches.len(), 1);
        let m = matches[0];
        assert_eq!(&source[m.start..m.end], "let s = \u{201C}你好\u{201D};");
    }

    #[test]
    fn match_view_cross_line_block_with_and_without_trailing_newline() {
        let source = "fn a() {\n    body();\n}\nfn b() {\n}\n";
        let block = "fn a() {\n    body();\n}";
        // 不带尾 \n：命中到行内容末尾
        let matches = match_view(source, block);
        assert_eq!(matches.len(), 1);
        assert_eq!(&source[matches[0].start..matches[0].end], block);
        // 带尾 \n：要求命中行的换行符也在区域内
        let matches = match_view(source, "fn a() {\n    body();\n}\n");
        assert_eq!(matches.len(), 1);
        let m = matches[0];
        assert_eq!(&source[m.start..m.end], "fn a() {\n    body();\n}\n");
    }

    #[test]
    fn line_ending_picks_dominant_ending() {
        assert_eq!(line_ending("a\r\nb\r\n", "\n"), "\r\n");
        assert_eq!(line_ending("a\nb\n", "\r\n"), "\n");
        assert_eq!(line_ending("plain", "\n"), "\n");
        // 两类一样多时用 fallback
        assert_eq!(line_ending("a\r\nb\n", "\n"), "\n");
    }

    #[test]
    fn align_lines_maps_kept_replaced_and_new_lines() {
        let before: Vec<String> = ["a", "b", "c"].iter().map(|s| s.to_string()).collect();
        let after: Vec<String> = ["a", "x", "c", "d"].iter().map(|s| s.to_string()).collect();
        let alignment = align_lines(&before, &after);
        assert_eq!(alignment[0], Some(0)); // a 沿用
        assert_eq!(alignment[1], Some(1)); // x 顶替 b 的位置
        assert_eq!(alignment[2], Some(2)); // c 沿用
        assert_eq!(alignment[3], None); // d 是新行
    }

    #[test]
    fn region_replacement_keeps_region_endings_for_kept_lines() {
        let source = "a\r\nbb\r\ncc\r\n";
        // 单行替换：没有行尾要决定
        let matches = match_view(source, "bb");
        assert_eq!(region_replacement(source, &matches[0], "bb2"), "bb2");
        // 跨行替换：bb、cc 沿用原区域行尾
        let matches = match_view(source, "bb\r\ncc");
        let replaced = region_replacement(source, &matches[0], "bb\ncc\ndd");
        assert_eq!(replaced, "bb\r\ncc\r\ndd");
    }

    #[test]
    fn region_replacement_new_lines_take_fallback_in_mixed_file() {
        // 区域本身是 LF，新行继承区域主导行尾，不污染成 \r\n
        let source = "one\r\ntwo\nthree\r\n";
        let matches = match_view(source, "two\nthree");
        let replaced = region_replacement(source, &matches[0], "two\nthree\nfour");
        assert_eq!(replaced, "two\nthree\nfour");
    }

    #[test]
    fn miss_hint_detects_already_applied_edit() {
        let source = "fn main() {\n    already_done();\n    and_more();\n}\n";
        let old = "fn main() {\n    already_done();\n    missing_line();\n";
        let hint = miss_hint(source, old, "    already_done();\n    and_more();\n");
        let hint = hint.expect("应检测到 new_string 已在文件里");
        assert!(hint.contains("new_string"), "实际: {hint}");
        assert!(hint.contains("已经应用"), "实际: {hint}");
    }

    #[test]
    fn miss_hint_votes_closest_lines_with_numbers() {
        let source =
            "import a;\n\nfn main() {\n    let x = compute(1);\n    if x > 0 {\n        println!(\"{x}\");\n    }\n}\n";
        // 缩进不对 → 精确与行级都匹配不上
        let old = "fn main() {\n  let x = compute(1);\n";
        let hint = miss_hint(source, old, "fn main() {\n");
        let hint = hint.expect("缩进不对但内容接近，应给出提示");
        assert!(hint.contains("3: fn main() {"), "实际: {hint}");
        assert!(hint.contains("let x = compute(1);"), "实际: {hint}");
    }

    #[test]
    fn miss_hint_returns_none_when_nothing_lines_up() {
        assert!(miss_hint("a\nb\n", "完全不同的一行\n", "x\n").is_none());
    }
}
