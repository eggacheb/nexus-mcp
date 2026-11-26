//! UTF-8 安全截断工具。
//!
//! `take_bytes_at_char_boundary` 原样取自 openai/codex
//! `codex-rs/utils/string/src/lib.rs`（Apache-2.0, Copyright 2025 OpenAI, see NOTICE）。
//! `truncated_prefix` / `aligned_tail` 是执行器渲染输出时处理「头尾预算切在
//! 多字节字符中间」的配套函数。

/// Truncate a &str to a byte budget at a char boundary (prefix).
#[inline]
pub fn take_bytes_at_char_boundary(s: &str, maxb: usize) -> &str {
    if s.len() <= maxb {
        return s;
    }
    let mut last_ok = 0;
    for (i, ch) in s.char_indices() {
        let nb = i + ch.len_utf8();
        if nb > maxb {
            break;
        }
        last_ok = nb;
    }
    &s[..last_ok]
}

/// 流式 UTF-8 lossy 解码：返回 `(解码文本, 实际消费的原始输入字节数)`。
/// - 合法 UTF-8 片段原样输出；
/// - 明确非法的字节序列（`error_len() == Some(k)`）替换为 `U+FFFD`，消费 `k` 个原始字节继续往后走；
/// - 切片末尾不完整的多字节 UTF-8 序列（`error_len() == None`，1~3 字节）：
///   `hold_incomplete_tail` 为 `true` 时保留不消费（留待下次补齐或头部截断丢弃碎尾），
///   为 `false` 时（如子进程已退出或紧邻中间省略段）按 `U+FFFD` 消费到底，确保偏移绝不卡死。
pub fn decode_lossy_stream(bytes: &[u8], hold_incomplete_tail: bool) -> (String, usize) {
    let mut out = String::new();
    let mut pos = 0usize;
    while pos < bytes.len() {
        match std::str::from_utf8(&bytes[pos..]) {
            Ok(valid) => {
                out.push_str(valid);
                pos = bytes.len();
                break;
            }
            Err(err) => {
                let valid_len = err.valid_up_to();
                if valid_len > 0 {
                    let valid = std::str::from_utf8(&bytes[pos..pos + valid_len])
                        .expect("valid_up_to 之内必为合法 UTF-8");
                    out.push_str(valid);
                    pos += valid_len;
                }
                match err.error_len() {
                    Some(invalid_len) => {
                        out.push('\u{FFFD}');
                        pos += invalid_len;
                    }
                    None => {
                        if !hold_incomplete_tail {
                            out.push('\u{FFFD}');
                            pos = bytes.len();
                        }
                        break;
                    }
                }
            }
        }
    }
    (out, pos)
}

/// 当调用方传入任意字节偏移 `start` 恰好落在快照内某个合法多字节 UTF-8 字符中间时，
/// 返回跳到该字符结尾所需的续字节数（1~3）；若本来就在字符边界或属于非法字节则返回 0。
pub fn utf8_straddle_skip(snapshot: &[u8], start: usize) -> usize {
    if start == 0 || start >= snapshot.len() || (snapshot[start] & 0xC0) != 0x80 {
        return 0;
    }
    let max_back = 3.min(start);
    for back in 1..=max_back {
        let lead_idx = start - back;
        if (snapshot[lead_idx] & 0xC0) == 0x80 {
            continue;
        }
        let rest = &snapshot[lead_idx..];
        let check_len = rest.len().min(4);
        match std::str::from_utf8(&rest[..check_len]) {
            Ok(s) => {
                if let Some(ch) = s.chars().next()
                    && ch.len_utf8() > back
                {
                    return ch.len_utf8() - back;
                }
            }
            Err(err) if err.valid_up_to() > 0 => {
                let s = std::str::from_utf8(&rest[..err.valid_up_to()]).unwrap_or("");
                if let Some(ch) = s.chars().next()
                    && ch.len_utf8() > back
                {
                    return ch.len_utf8() - back;
                }
            }
            Err(_) => {}
        }
        break;
    }
    0
}

/// 头部渲染用：中间遇到非 UTF-8 字节按 `U+FFFD` lossy 保留后续内容，仅丢掉末尾被预算切开的
/// 不完整 UTF-8 尾序列（最多 3 字节），再按字节预算在字符边界截断。
pub fn truncated_prefix(bytes: &[u8], budget: usize) -> String {
    let (decoded, _) = decode_lossy_stream(bytes, true);
    take_bytes_at_char_boundary(&decoded, budget).to_string()
}

/// 尾部渲染用：跳过开头不完整的 UTF-8 续字节（最多 3 字节），让尾部从字符边界开始。
pub fn aligned_tail(bytes: &[u8]) -> &[u8] {
    let mut i = 0;
    while i < bytes.len() && i < 3 && bytes[i] & 0xC0 == 0x80 {
        i += 1;
    }
    &bytes[i..]
}

#[cfg(test)]
mod tests {
    use super::{
        aligned_tail, decode_lossy_stream, take_bytes_at_char_boundary, truncated_prefix,
        utf8_straddle_skip,
    };

    #[test]
    fn take_bytes_keeps_whole_chars_only() {
        assert_eq!(take_bytes_at_char_boundary("中文", 4), "中");
        assert_eq!(take_bytes_at_char_boundary("中文", 1), "");
        assert_eq!(take_bytes_at_char_boundary("中文", 100), "中文");
        assert_eq!(take_bytes_at_char_boundary("abc", 2), "ab");
    }

    #[test]
    fn truncated_prefix_drops_partial_trailing_char() {
        // "中文" 的前 4 字节：完整的 "中" + "文" 的第 1 个字节
        let bytes = &"中文".as_bytes()[..4];
        assert_eq!(truncated_prefix(bytes, 4), "中");
        assert_eq!(truncated_prefix("中文".as_bytes(), 100), "中文");
        assert_eq!(truncated_prefix("中文".as_bytes(), 3), "中");
    }

    #[test]
    fn aligned_tail_skips_leading_continuation_bytes() {
        assert_eq!(aligned_tail(&[0x80, 0x80, b'a']), b"a");
        assert_eq!(aligned_tail(b"ab"), b"ab");
        assert_eq!(aligned_tail(&[0x80, 0x80, 0x80]), &[] as &[u8]);
        // "中文" = 6 字节；[3..] 恰好从 "文" 的起始字节开始 → 原样保留
        assert_eq!(aligned_tail(&"中文".as_bytes()[3..]), "文".as_bytes());
        // [4..] 开头是 "文" 的两个续字节 → 全部跳过
        assert_eq!(aligned_tail(&"中文".as_bytes()[4..]), &[] as &[u8]);
    }

    #[test]
    fn truncated_prefix_and_lossy_stream_preserve_text_after_invalid_bytes() {
        let mixed = b"HEAD\xff\xfeAFTER\xe4\xb8";
        assert_eq!(truncated_prefix(mixed, 100), "HEAD\u{FFFD}\u{FFFD}AFTER");

        let (live_text, live_consumed) = decode_lossy_stream(mixed, true);
        assert_eq!(live_text, "HEAD\u{FFFD}\u{FFFD}AFTER");
        assert_eq!(live_consumed, mixed.len() - 2);

        let (final_text, final_consumed) = decode_lossy_stream(mixed, false);
        assert_eq!(final_text, "HEAD\u{FFFD}\u{FFFD}AFTER\u{FFFD}");
        assert_eq!(final_consumed, mixed.len());

        let cn = "中文".as_bytes();
        assert_eq!(utf8_straddle_skip(cn, 1), 2);
        assert_eq!(utf8_straddle_skip(cn, 3), 0);
        assert_eq!(utf8_straddle_skip(b"a\x80b", 1), 0);
    }
}
