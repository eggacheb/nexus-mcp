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

/// 头部渲染用：丢掉结尾不完整的 UTF-8 序列（最多 3 字节），再按字节预算在字符
/// 边界截断。保证返回的字符串完整合法、不超过预算。
pub fn truncated_prefix(bytes: &[u8], budget: usize) -> String {
    let valid_up_to = match std::str::from_utf8(bytes) {
        Ok(_) => bytes.len(),
        Err(err) => err.valid_up_to(),
    };
    let prefix = std::str::from_utf8(&bytes[..valid_up_to]).unwrap_or("");
    take_bytes_at_char_boundary(prefix, budget).to_string()
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
    use super::{aligned_tail, take_bytes_at_char_boundary, truncated_prefix};

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
}
