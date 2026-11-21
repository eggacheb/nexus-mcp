//! A capped byte buffer that preserves a stable prefix ("head") and suffix ("tail"),
//! dropping the middle once it exceeds the configured maximum. The buffer is
//! symmetric meaning 50% of the capacity is allocated to the head and 50% is
//! allocated to the tail.
//!
//! derived from openai/codex `codex-rs/utils/head-tail-buffer/src/lib.rs`
//! (Apache-2.0, Copyright 2025 OpenAI, see NOTICE).
//! Modified from upstream: the const-generic `MAX_BYTES` budget became a runtime
//! value (`new(max_bytes)`), budget/segment accessors were added for rendering,
//! and `push_buffer` / `to_bytes_with_omission_marker` were dropped as unused
//! (rendering with UTF-8-safe boundaries lives in the executor's `render_output`).

use std::collections::VecDeque;

#[derive(Debug, Eq, PartialEq)]
pub struct HeadTailBuffer {
    head: Vec<u8>,
    tail: VecDeque<u8>,
    omitted_bytes: usize,
    max_bytes: usize,
}

impl HeadTailBuffer {
    /// Create a buffer that never retains more than `max_bytes` (50% head + 50% tail).
    pub fn new(max_bytes: usize) -> Self {
        Self {
            head: Vec::new(),
            tail: VecDeque::new(),
            omitted_bytes: 0,
            max_bytes,
        }
    }

    /// Budget of the stable prefix. Public because rendering needs the exact cut point.
    pub fn head_budget(&self) -> usize {
        self.max_bytes / 2
    }

    /// Budget of the rolling suffix.
    #[allow(dead_code)] // 渲染用不到，测试与后续 job_output 会用
    pub fn tail_budget(&self) -> usize {
        self.max_bytes.saturating_sub(self.head_budget())
    }

    /// Total bytes currently retained by the buffer (head + tail).
    pub fn retained_bytes(&self) -> usize {
        self.head.len().saturating_add(self.tail.len())
    }

    /// Total bytes that were dropped from the middle due to the size cap.
    pub fn omitted_bytes(&self) -> usize {
        self.omitted_bytes
    }

    /// Total bytes observed by the buffer, including bytes omitted by the cap.
    #[allow(dead_code)] // 渲染用不到，测试与后续 job_output 会用
    pub fn total_bytes(&self) -> usize {
        self.retained_bytes().saturating_add(self.omitted_bytes)
    }

    /// Stable prefix bytes. When bytes were omitted, this is always exactly
    /// `head_budget()` bytes long.
    pub fn head_bytes(&self) -> &[u8] {
        &self.head
    }

    /// Rolling suffix bytes. When bytes were omitted, this is always exactly
    /// `tail_budget()` bytes long.
    pub fn tail_bytes(&mut self) -> &[u8] {
        self.tail.make_contiguous()
    }

    /// Append a chunk of bytes to the buffer.
    ///
    /// Bytes are first added to the head until the head budget is full; any
    /// remaining bytes are added to the tail, with older tail bytes being
    /// dropped to preserve the tail budget.
    pub fn push_chunk(&mut self, chunk: &[u8]) {
        let chunk = self.fill_head(chunk);
        self.push_tail(chunk);
    }

    /// Fill the stable prefix and return the bytes that did not fit.
    fn fill_head<'a>(&mut self, chunk: &'a [u8]) -> &'a [u8] {
        let remaining_head = self.head_budget().saturating_sub(self.head.len());
        // A shorter chunk fits entirely in the head.
        let (chunk_head, chunk_tail) = chunk
            .split_at_checked(remaining_head)
            .unwrap_or((chunk, &[]));
        self.head.extend_from_slice(chunk_head);
        chunk_tail
    }

    /// Append bytes known not to belong in the head, keeping the newest tail bytes.
    fn push_tail(&mut self, chunk: &[u8]) {
        let Self {
            head: _,
            tail,
            omitted_bytes,
            max_bytes,
        } = self;

        let head_budget = *max_bytes / 2;
        let tail_budget = max_bytes.saturating_sub(head_budget);
        let remaining_tail = tail_budget.saturating_sub(tail.len());
        let excess_tail = chunk.len().saturating_sub(remaining_tail);
        *omitted_bytes = omitted_bytes.saturating_add(excess_tail);

        // Discard old tail bytes first, then skip any excess incoming bytes.
        let chunk = match excess_tail.checked_sub(tail.len()) {
            None => {
                tail.drain(..excess_tail);
                chunk
            }
            Some(skip) => {
                tail.clear();
                &chunk[skip..]
            }
        };
        tail.extend(chunk);
    }

    /// Return the retained output as a single byte vector.
    ///
    /// The output is formed by concatenating head chunks, then tail chunks.
    /// Omitted bytes are not represented in the returned value.
    pub fn to_bytes(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(self.retained_bytes());
        out.extend_from_slice(&self.head);
        out.extend(self.tail.iter().copied());
        out
    }
}

/// Render the byte omission notice used by callers of the buffer.
pub fn format_output_omission_marker(omitted_bytes: usize) -> String {
    format!("... {omitted_bytes} bytes omitted ...")
}

#[cfg(test)]
mod tests {
    use super::HeadTailBuffer;

    #[test]
    fn keeps_prefix_and_suffix_when_over_budget() {
        let mut buf = HeadTailBuffer::new(10);

        buf.push_chunk(b"0123456789");
        assert_eq!(buf.omitted_bytes(), 0);

        // Exceeds max by 2; we should keep head+tail and omit the middle.
        buf.push_chunk(b"ab");
        assert!(buf.omitted_bytes() > 0);

        let rendered = String::from_utf8_lossy(&buf.to_bytes()).to_string();
        assert!(rendered.starts_with("01234"));
        assert!(rendered.ends_with("89ab"));
    }

    #[test]
    fn max_bytes_zero_drops_everything() {
        let mut buf = HeadTailBuffer::new(0);
        buf.push_chunk(b"abc");

        assert_eq!(buf.retained_bytes(), 0);
        assert_eq!(buf.omitted_bytes(), 3);
        assert_eq!(buf.to_bytes(), b"");
    }

    #[test]
    fn head_budget_zero_keeps_only_last_byte_in_tail() {
        let mut buf = HeadTailBuffer::new(1);
        buf.push_chunk(b"abc");

        assert_eq!(buf.retained_bytes(), 1);
        assert_eq!(buf.omitted_bytes(), 2);
        assert_eq!(buf.to_bytes(), b"c");
    }

    #[test]
    fn chunk_larger_than_tail_budget_keeps_only_tail_end() {
        let mut buf = HeadTailBuffer::new(10);
        buf.push_chunk(b"0123456789");

        // Tail budget is 5 bytes. This chunk should replace the tail and keep
        // only its last 5 bytes.
        buf.push_chunk(b"ABCDEFGHIJK");

        let out = String::from_utf8_lossy(&buf.to_bytes()).to_string();
        assert!(out.starts_with("01234"));
        assert!(out.ends_with("GHIJK"));
        assert!(buf.omitted_bytes() > 0);
    }

    #[test]
    fn fills_head_then_tail_across_multiple_chunks() {
        let mut buf = HeadTailBuffer::new(10);

        // Fill the 5-byte head budget across multiple chunks.
        buf.push_chunk(b"01");
        buf.push_chunk(b"234");
        assert_eq!(buf.to_bytes(), b"01234");

        // Then fill the 5-byte tail budget.
        buf.push_chunk(b"567");
        buf.push_chunk(b"89");
        assert_eq!(buf.to_bytes(), b"0123456789");
        assert_eq!(buf.omitted_bytes(), 0);

        // One more byte causes the tail to drop its oldest byte.
        buf.push_chunk(b"a");
        assert_eq!(buf.to_bytes(), b"012346789a");
        assert_eq!(buf.omitted_bytes(), 1);
    }

    #[test]
    fn empty_and_tiny_chunks_have_bounded_metadata() {
        let mut buf = HeadTailBuffer::new(10);

        for byte in b"0123456789ab" {
            buf.push_chunk(&[]);
            buf.push_chunk(&[*byte]);
        }

        assert_eq!(buf.retained_bytes(), 10);
        assert_eq!(buf.omitted_bytes(), 2);
    }

    #[test]
    fn total_bytes_tracks_observed_bytes() {
        let mut buf = HeadTailBuffer::new(10);
        buf.push_chunk(b"0123456789abcdef");

        assert_eq!(buf.total_bytes(), 16);
        assert_eq!(buf.retained_bytes(), 10);
        assert_eq!(buf.omitted_bytes(), 6);
        assert_eq!(buf.head_bytes().len(), buf.head_budget());
        assert_eq!(buf.tail_bytes().len(), buf.tail_budget());
    }
}
