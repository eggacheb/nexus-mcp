//! 执行器协议与 bash 执行的测试。需要 Git Bash（可用 NEXUS_GIT_BASH 指定路径）。

use super::*;
use serde_json::json;
use std::time::Instant;

fn git_bash() -> Option<String> {
    let path = std::env::var("NEXUS_GIT_BASH")
        .unwrap_or_else(|_| r"C:\Program Files\Git\bin\bash.exe".into());
    if Path::new(&path).exists() {
        Some(path)
    } else {
        None
    }
}

fn bash_line(command: &str, timeout_ms: u64, max_output_bytes: usize) -> String {
    let program = git_bash().expect("本测试需要 Git Bash（或设置 NEXUS_GIT_BASH）");
    json!({
        "id": 7,
        "op": "bash",
        "command": command,
        "cwd": env!("CARGO_MANIFEST_DIR"),
        "timeout_ms": timeout_ms,
        "max_output_bytes": max_output_bytes,
        "shell": { "kind": "git-bash", "program": program }
    })
    .to_string()
}

#[test]
fn unknown_op_returns_error_with_id() {
    let line = json!({
        "id": 3,
        "op": "nope",
        "command": "echo hi",
        "cwd": env!("CARGO_MANIFEST_DIR"),
        "timeout_ms": 1000,
        "max_output_bytes": 1024,
        "shell": { "kind": "git-bash", "program": git_bash().unwrap_or_default() }
    })
    .to_string();
    let response = handle_request(&line);
    assert_eq!(response["id"], json!(3));
    assert_eq!(response["ok"], json!(false));
    assert!(response["error"].as_str().unwrap().contains("未知 op"));
}

#[test]
fn malformed_line_returns_parse_error() {
    let response = handle_request("这不是 JSON");
    assert_eq!(response["id"], Value::Null);
    assert_eq!(response["ok"], json!(false));
    assert!(response["error"].as_str().unwrap().contains("请求解析失败"));
}

#[test]
fn bash_echo_returns_output_and_exit_code() {
    let response = handle_request(&bash_line("echo cargo-executor-你好", 10_000, 64 * 1024));
    assert_eq!(response["ok"], json!(true));
    assert_eq!(response["exit_code"], json!(0));
    assert!(response["output"].as_str().unwrap().contains("cargo-executor-你好"));
}

#[test]
fn stderr_merged_and_nonzero_exit_code_preserved() {
    let response = handle_request(&bash_line("echo 出错 >&2; exit 3", 10_000, 64 * 1024));
    assert_eq!(response["ok"], json!(true));
    assert_eq!(response["exit_code"], json!(3));
    assert!(response["output"].as_str().unwrap().contains("出错"));
}

#[test]
fn timeout_kills_child_and_reports() {
    let started = Instant::now();
    let response = handle_request(&bash_line("sleep 2", 300, 64 * 1024));
    assert!(started.elapsed() < Duration::from_millis(2_000));
    assert_eq!(response["timed_out"], json!(true));
    assert_eq!(response["exit_code"], Value::Null);
}

#[test]
fn oversized_output_gets_omission_marker() {
    let response = handle_request(&bash_line("seq 1 5000", 10_000, 1000));
    assert_eq!(response["ok"], json!(true));
    assert!(response["output"].as_str().unwrap().contains("bytes omitted"));
}

#[test]
fn missing_cwd_is_a_clean_error() {
    let line = json!({
        "id": 8,
        "op": "bash",
        "command": "echo hi",
        "cwd": "X:\\不存在的目录",
        "timeout_ms": 1000,
        "max_output_bytes": 1024,
        "shell": { "kind": "git-bash", "program": git_bash().unwrap_or_default() }
    })
    .to_string();
    let response = handle_request(&line);
    assert_eq!(response["ok"], json!(false));
    assert!(response["error"].as_str().unwrap().contains("工作目录"));
}

#[test]
fn oversized_chinese_output_stays_valid_utf8() {
    let response = handle_request(&bash_line(
        "for i in $(seq 1 4000); do echo \"第${i}行\"; done",
        10_000,
        2048,
    ));
    let output = response["output"].as_str().unwrap();
    assert!(output.contains("bytes omitted"));
    assert!(!output.contains('\u{FFFD}'));
}

#[test]
fn ping_replies_pong_with_id() {
    let response = handle_request(r#"{"id":5,"op":"ping"}"#);
    assert_eq!(response["id"], json!(5));
    assert_eq!(response["ok"], json!(true));
    assert_eq!(response["pong"], json!(true));
}

#[test]
fn render_output_fixes_utf8_boundaries_at_cut_points() {
    let mut buffer = HeadTailBuffer::new(8);
    // "中文输出" 共 12 字节（每个汉字 3 字节），预算 8：头部 4 字节切在 "文" 中间，
    // 尾部 4 字节切在 "输" 中间；渲染时两端各丢掉碎字节，不留替换字符
    buffer.push_chunk("中文输出".as_bytes());
    let rendered = render_output(&mut buffer);
    assert_eq!(rendered, "中\n... 4 bytes omitted ...\n出");
}
