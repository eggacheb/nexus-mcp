//! 执行器协议与 bash 执行的测试。需要 Git Bash（可用 NEXUS_GIT_BASH 指定路径）。

use super::*;
use serde_json::json;
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
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
        "root": env!("CARGO_MANIFEST_DIR"),
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
    let missing_inside = Path::new(env!("CARGO_MANIFEST_DIR")).join("不存在的子目录");
    let line = json!({
        "id": 8,
        "op": "bash",
        "command": "echo hi",
        "root": env!("CARGO_MANIFEST_DIR"),
        "cwd": missing_inside.to_string_lossy(),
        "timeout_ms": 1000,
        "max_output_bytes": 1024,
        "shell": { "kind": "git-bash", "program": git_bash().unwrap_or_default() }
    })
    .to_string();
    let response = handle_request(&line);
    assert_eq!(response["ok"], json!(false));
    assert!(response["error"].as_str().unwrap().contains("工作目录"));

    let outside_line = json!({
        "id": 9,
        "op": "bash",
        "command": "echo hi",
        "root": env!("CARGO_MANIFEST_DIR"),
        "cwd": "X:\\越界目录",
        "timeout_ms": 1000,
        "max_output_bytes": 1024,
        "shell": { "kind": "git-bash", "program": git_bash().unwrap_or_default() }
    })
    .to_string();
    let outside_resp = handle_request(&outside_line);
    assert_eq!(outside_resp["ok"], json!(false));
    assert!(outside_resp["error"].as_str().unwrap().contains("路径越界"));
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

// ---------- read / write op 测试 ----------

static TEMP_COUNTER: AtomicUsize = AtomicUsize::new(0);

fn temp_root(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "nexus-exec-{tag}-{}-{}",
        std::process::id(),
        TEMP_COUNTER.fetch_add(1, Ordering::Relaxed)
    ));
    fs::create_dir_all(&dir).expect("创建临时根目录失败");
    dir
}

fn read_request_line(
    root: &Path,
    path: &Path,
    offset: Option<u64>,
    limit: Option<u64>,
    max_output_bytes: u64,
) -> String {
    json!({
        "id": 9,
        "op": "read",
        "path": path.to_string_lossy(),
        "root": root.to_string_lossy(),
        "offset": offset,
        "limit": limit,
        "max_output_bytes": max_output_bytes
    })
    .to_string()
}

fn write_request_line(root: &Path, path: &Path, content: &str) -> String {
    json!({
        "id": 10,
        "op": "write",
        "path": path.to_string_lossy(),
        "root": root.to_string_lossy(),
        "content": content
    })
    .to_string()
}

/// 造「根内入口 → 根外目标」的逃逸链接，返回 (read 用路径, write 用路径)。
/// Windows 无符号链接特权时退回免特权的目录 junction；unix 用文件符号链接。
/// 都造不出来返回 None（调用方跳过断言）。
fn make_escape_paths(root: &Path, outside_dir: &Path) -> Option<(PathBuf, PathBuf)> {
    #[cfg(windows)]
    {
        let link = root.join("leakdir");
        let status = Command::new("cmd")
            .args(["/c", "mklink", "/j"])
            .arg(&link)
            .arg(outside_dir)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .ok()?;
        if status.success() && link.is_dir() {
            Some((link.join("target.txt"), link.join("new.txt")))
        } else {
            None
        }
    }
    #[cfg(not(windows))]
    {
        let link = root.join("leak.md");
        std::os::unix::fs::symlink(outside_dir.join("target.txt"), &link).ok()?;
        Some((link.clone(), link))
    }
}

fn cleanup(dir: &Path) {
    let _ = fs::remove_dir_all(dir);
}

/// glob/grep 共用的最小 root：临时目录 + git init（require_git(true) 下
/// .gitignore 只有在 git 仓库里才生效）。
fn search_root(name: &str) -> PathBuf {
    let root = temp_root(name);
    let status = std::process::Command::new("git")
        .args(["init", "--quiet"])
        .current_dir(&root)
        .status()
        .expect("本测试需要 git");
    assert!(status.success(), "git init 失败");
    fs::write(root.join(".gitignore"), "ignored/\n").unwrap();
    fs::create_dir(root.join("src")).unwrap();
    fs::write(root.join("src").join("a.txt"), "alpha\n").unwrap();
    fs::create_dir(root.join("ignored")).unwrap();
    fs::write(root.join("ignored").join("b.txt"), "beta\n").unwrap();
    root
}

#[test]
fn glob_op_respects_gitignore_and_reports_relpaths() {
    let root = search_root("glob-ok");
    let line = json!({
        "id": 20, "op": "glob", "root": root.to_string_lossy(),
        "pattern": "**/*.txt", "max_results": 10
    })
    .to_string();
    let response = handle_request(&line);
    assert_eq!(response["ok"], json!(true), "实际: {response}");
    let paths: Vec<&str> = response["paths"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(Value::as_str)
        .collect();
    assert!(paths.contains(&"src/a.txt"), "实际: {paths:?}");
    assert!(!paths.iter().any(|p| p.contains("ignored/")), "实际: {paths:?}");
    assert_eq!(response["total_matches"], json!(1));
    assert_eq!(response["truncated"], json!(false));
    cleanup(&root);
}

#[test]
fn glob_op_rejects_escape_and_missing_start() {
    let root = search_root("glob-escape");
    let line = json!({
        "id": 21, "op": "glob", "root": root.to_string_lossy(),
        "path": root.join("..").join("elsewhere").to_string_lossy(),
        "pattern": "*.txt", "max_results": 10
    })
    .to_string();
    let response = handle_request(&line);
    assert_eq!(response["ok"], json!(false));
    assert!(response["error"].as_str().unwrap().contains("越界"));

    let line = json!({
        "id": 22, "op": "glob", "root": root.to_string_lossy(),
        "path": "no-such-dir-xyz", "pattern": "*.txt", "max_results": 10
    })
    .to_string();
    let response = handle_request(&line);
    assert_eq!(response["ok"], json!(false));
    assert!(response["error"].as_str().unwrap().contains("目录"));
    cleanup(&root);
}

#[test]
fn grep_op_rejects_invalid_regex_with_ripgrep_stderr() {
    // rg 在 PATH 上才跑；没有时静默通过（执行器会走下载兜底，测试不能联网）
    if ripgrep::find_in_path().is_none() {
        return;
    }
    let root = search_root("grep-invalid-regex");
    let line = json!({
        "id": 23, "op": "grep", "root": root.to_string_lossy(),
        "pattern": "([unclosed", "max_results": 10
    })
    .to_string();
    let response = handle_request(&line);
    assert_eq!(response["ok"], json!(false));
    let message = response["error"].as_str().unwrap();
    assert!(message.contains("ripgrep"), "实际: {message}");
    cleanup(&root);
}

#[test]
fn read_op_returns_numbered_lines_matching_real_positions() {
    let root = temp_root("read-numbered");
    fs::write(root.join("n.txt"), "l1\nl2\nl3\n").unwrap();
    let response = handle_request(&read_request_line(
        &root,
        &root.join("n.txt"),
        None,
        None,
        64 * 1024,
    ));
    assert_eq!(response["ok"], json!(true));
    assert_eq!(response["total_lines"], json!(3));
    assert_eq!(response["start_line"], json!(1));
    assert_eq!(response["end_line"], json!(3));
    let content = response["content"].as_str().unwrap();
    assert!(content.contains("     1\tl1"), "实际: {content}");
    assert!(content.contains("     2\tl2"));
    assert!(content.contains("     3\tl3"));
    cleanup(&root);
}

#[test]
fn read_op_offset_limit_slice_keeps_real_line_numbers() {
    let root = temp_root("read-slice");
    let lines: Vec<String> = (1..=10).map(|i| format!("第{i}行")).collect();
    let file = root.join("s.txt");
    fs::write(&file, format!("{}\n", lines.join("\n"))).unwrap();
    let response = handle_request(&read_request_line(&root, &file, Some(4), Some(3), 64 * 1024));
    assert_eq!(response["ok"], json!(true));
    assert_eq!(response["start_line"], json!(4));
    assert_eq!(response["end_line"], json!(6));
    let content = response["content"].as_str().unwrap();
    assert!(content.contains("     4\t第4行"));
    assert!(content.contains("     6\t第6行"));
    assert!(!content.contains("第3行"));
    assert!(!content.contains("第7行"));
    cleanup(&root);
}

#[test]
fn read_op_offset_beyond_eof_returns_existing_part() {
    let root = temp_root("read-eof");
    let file = root.join("t.txt");
    fs::write(&file, "一\n二\n三\n").unwrap();
    let partial = handle_request(&read_request_line(&root, &file, Some(2), Some(50), 64 * 1024));
    assert_eq!(partial["ok"], json!(true));
    assert_eq!(partial["start_line"], json!(2));
    assert_eq!(partial["end_line"], json!(3));
    assert!(partial["content"].as_str().unwrap().contains("     3\t三"));

    let beyond = handle_request(&read_request_line(&root, &file, Some(99), None, 64 * 1024));
    assert_eq!(beyond["ok"], json!(true));
    assert_eq!(beyond["start_line"], json!(0));
    assert_eq!(beyond["end_line"], json!(0));
    assert_eq!(beyond["content"], json!(""));

    let empty_path = root.join("empty.txt");
    fs::write(&empty_path, "").unwrap();
    let empty = handle_request(&read_request_line(&root, &empty_path, None, None, 64 * 1024));
    assert_eq!(empty["ok"], json!(true));
    assert_eq!(empty["total_lines"], json!(0));
    cleanup(&root);
}

#[test]
fn read_op_line_cap_stops_at_limit_and_byte_cap_marks_omitted() {
    let root = temp_root("read-cap");
    let file = root.join("big.txt");
    let lines: Vec<String> = (1..=2100).map(|i| format!("line-{i}")).collect();
    fs::write(&file, format!("{}\n", lines.join("\n"))).unwrap();
    let response = handle_request(&read_request_line(&root, &file, None, None, 64 * 1024));
    assert_eq!(response["ok"], json!(true));
    assert_eq!(response["total_lines"], json!(2100));
    assert_eq!(response["end_line"], json!(2000));
    let content = response["content"].as_str().unwrap();
    assert!(content.contains("2000\tline-2000"));
    assert!(!content.contains("line-2001"));

    let byte_capped =
        handle_request(&read_request_line(&root, &file, None, Some(50), 200));
    assert_eq!(byte_capped["ok"], json!(true));
    assert!(byte_capped["omitted_lines"].as_u64().unwrap() > 0);
    let capped_content = byte_capped["content"].as_str().unwrap();
    assert!(!capped_content.contains('\u{FFFD}'));
    // 行号前缀与换行也计入预算，总输出不超过上限
    assert!(capped_content.len() <= 200, "实际 {} 字节", capped_content.len());
    cleanup(&root);
}

#[test]
fn read_op_rejects_non_utf8_with_readable_error() {
    let root = temp_root("read-utf8");
    let file = root.join("bin.dat");
    fs::write(&file, [0xFFu8, 0xFE, 0x41, 0x00]).unwrap();
    let response = handle_request(&read_request_line(&root, &file, None, None, 64 * 1024));
    assert_eq!(response["ok"], json!(false));
    let error = response["error"].as_str().unwrap();
    assert!(error.contains("UTF-8"), "实际: {error}");
    assert!(!error.contains('\u{FFFD}'));
    cleanup(&root);
}

#[test]
fn read_op_missing_file_and_directory_are_clean_errors() {
    let root = temp_root("read-missing");
    let missing = handle_request(&read_request_line(
        &root,
        &root.join("ghost.txt"),
        None,
        None,
        64 * 1024,
    ));
    assert_eq!(missing["ok"], json!(false));
    assert!(missing["error"].as_str().unwrap().contains("不存在"));

    let dir = handle_request(&read_request_line(&root, &root, None, None, 64 * 1024));
    assert_eq!(dir["ok"], json!(false));
    assert!(dir["error"].as_str().unwrap().contains("目录"));
    cleanup(&root);
}

#[test]
fn read_op_rejects_dotdot_escape_and_names_the_path() {
    let root = temp_root("read-dotdot");
    let outside = root.join("..").join("read-escape-payload.txt");
    let response = handle_request(&read_request_line(&root, &outside, None, None, 64 * 1024));
    assert_eq!(response["ok"], json!(false));
    let error = response["error"].as_str().unwrap();
    assert!(error.contains("越界"), "实际: {error}");
    assert!(error.contains("read-escape-payload.txt"), "实际: {error}");
    cleanup(&root);
}

#[test]
fn read_op_rejects_symlink_escape_and_names_the_path() {
    let root = temp_root("read-link");
    let outside = temp_root("read-link-out");
    fs::write(outside.join("target.txt"), "secret").unwrap();
    let Some((read_path, _)) = make_escape_paths(&root, &outside) else {
        eprintln!("跳过：造不出逃逸链接（无特权且 junction 失败）");
        cleanup(&root);
        cleanup(&outside);
        return;
    };
    let response = handle_request(&read_request_line(&root, &read_path, None, None, 64 * 1024));
    assert_eq!(response["ok"], json!(false));
    let error = response["error"].as_str().unwrap();
    assert!(error.contains("越界"), "实际: {error}");
    assert!(error.contains("leak"), "实际: {error}");
    cleanup(&root);
    cleanup(&outside);
}

#[test]
fn read_op_accepts_dotdot_within_root_and_forward_slash_paths() {
    let root = temp_root("read-slash");
    fs::create_dir_all(root.join("sub")).unwrap();
    fs::write(root.join("sub").join("f.txt"), "inside").unwrap();
    // 反斜杠 + .. 留在根内
    let inner = root.join("sub").join("..").join("sub").join("f.txt");
    let response = handle_request(&read_request_line(&root, &inner, None, None, 64 * 1024));
    assert_eq!(response["ok"], json!(true));
    assert!(response["content"].as_str().unwrap().contains("inside"));
    // 正斜杠绝对路径（Windows 盘符 + /）
    let forward = format!("{}/sub/f.txt", root.to_string_lossy().replace('\\', "/"));
    let response = handle_request(&read_request_line(&root, Path::new(&forward), None, None, 64 * 1024));
    assert_eq!(response["ok"], json!(true), "实际: {response}");
    assert!(response["content"].as_str().unwrap().contains("inside"));
    cleanup(&root);
}

#[test]
fn write_op_creates_overwrites_and_preserves_line_endings_exactly() {
    let root = temp_root("write-basic");
    let file = root.join("crlf.txt");
    let first = handle_request(&write_request_line(&root, &file, "第一行\r\nsecond\r\n"));
    assert_eq!(first["ok"], json!(true));
    assert_eq!(first["bytes_written"], json!("第一行\r\nsecond\r\n".len()));
    assert_eq!(fs::read(&file).unwrap(), "第一行\r\nsecond\r\n".as_bytes());

    let overwrite = handle_request(&write_request_line(&root, &file, "only"));
    assert_eq!(overwrite["ok"], json!(true));
    assert_eq!(fs::read(&file).unwrap(), b"only");
    cleanup(&root);
}

#[test]
fn write_op_missing_parent_is_readable_error_without_creating_dirs() {
    let root = temp_root("write-parent");
    let target = root.join("no-such-dir").join("deep").join("child.txt");
    let response = handle_request(&write_request_line(&root, &target, "x"));
    assert_eq!(response["ok"], json!(false));
    assert!(response["error"].as_str().unwrap().contains("目录"));
    assert!(!root.join("no-such-dir").exists());
    cleanup(&root);
}

#[test]
fn write_op_rejects_root_itself() {
    let root = temp_root("write-root");
    let response = handle_request(&write_request_line(&root, &root, "x"));
    assert_eq!(response["ok"], json!(false));
    assert!(response["error"].as_str().unwrap().contains("根目录"));
    // 带尾部分隔符的同义写法同样拒绝
    let with_slash = PathBuf::from(format!("{}\\", root.to_string_lossy()));
    let response = handle_request(&write_request_line(&root, &with_slash, "x"));
    assert_eq!(response["ok"], json!(false));
    assert!(response["error"].as_str().unwrap().contains("根目录"));
    cleanup(&root);
}

#[test]
fn write_op_rejects_existing_directory_target() {
    let root = temp_root("write-dir");
    fs::create_dir_all(root.join("docs")).unwrap();
    let response = handle_request(&write_request_line(&root, &root.join("docs"), "x"));
    assert_eq!(response["ok"], json!(false));
    assert!(response["error"].as_str().unwrap().contains("目录"));
    cleanup(&root);
}

#[test]
fn write_op_rejects_dotdot_escape_and_names_the_path() {
    let root = temp_root("write-dotdot");
    let outside = root.join("..").join("write-escape-payload.txt");
    let response = handle_request(&write_request_line(&root, &outside, "x"));
    assert_eq!(response["ok"], json!(false));
    let error = response["error"].as_str().unwrap();
    assert!(error.contains("越界"), "实际: {error}");
    assert!(error.contains("write-escape-payload.txt"), "实际: {error}");
    assert!(!root.join("..").join("write-escape-payload.txt").exists());
    cleanup(&root);
}

#[test]
fn write_op_rejects_symlink_escape_and_names_the_path() {
    let root = temp_root("write-link");
    let outside = temp_root("write-link-out");
    fs::write(outside.join("target.txt"), "secret").unwrap();
    let Some((_, write_path)) = make_escape_paths(&root, &outside) else {
        eprintln!("跳过：造不出逃逸链接（无特权且 junction 失败）");
        cleanup(&root);
        cleanup(&outside);
        return;
    };
    let response = handle_request(&write_request_line(&root, &write_path, "x"));
    assert_eq!(response["ok"], json!(false));
    let error = response["error"].as_str().unwrap();
    assert!(error.contains("越界"), "实际: {error}");
    assert!(error.contains("leak"), "实际: {error}");
    cleanup(&root);
    cleanup(&outside);
}

#[test]
fn write_op_rejects_dangling_symlink_instead_of_writing_through() {
    let root = temp_root("write-dangling");
    // Windows 文件符号链接需要特权；没有就跳过（junction 只能指目录，造不出悬空文件链接）
    #[cfg(windows)]
    {
        use std::os::windows::fs::symlink_file;
        let link = root.join("dangling.md");
        if symlink_file(root.join("gone.txt"), &link).is_err() {
            eprintln!("跳过：无符号链接特权");
            cleanup(&root);
            return;
        }
        let response = handle_request(&write_request_line(&root, &link, "x"));
        assert_eq!(response["ok"], json!(false));
        assert!(response["error"].as_str().unwrap().contains("符号链接"));
        assert!(!root.join("gone.txt").exists());
    }
    #[cfg(not(windows))]
    {
        let link = root.join("dangling.md");
        std::os::unix::fs::symlink(root.join("gone.txt"), &link).unwrap();
        let response = handle_request(&write_request_line(&root, &link, "x"));
        assert_eq!(response["ok"], json!(false));
        assert!(response["error"].as_str().unwrap().contains("符号链接"));
        assert!(!root.join("gone.txt").exists());
    }
    cleanup(&root);
}

#[test]
fn read_write_ops_missing_fields_give_readable_errors() {
    let response = handle_request(r#"{"id":11,"op":"read"}"#);
    assert_eq!(response["ok"], json!(false));
    assert!(response["error"].as_str().unwrap().contains("read 请求字段有误"));

    let response = handle_request(r#"{"id":12,"op":"write"}"#);
    assert_eq!(response["ok"], json!(false));
    assert!(response["error"].as_str().unwrap().contains("write 请求字段有误"));
}

// ---------- edit op 测试 ----------

fn edit_request_line(
    root: &Path,
    path: &Path,
    old_string: &str,
    new_string: &str,
    replace_all: bool,
) -> String {
    json!({
        "id": 13,
        "op": "edit",
        "path": path.to_string_lossy(),
        "root": root.to_string_lossy(),
        "old_string": old_string,
        "new_string": new_string,
        "replace_all": replace_all
    })
    .to_string()
}

#[test]
fn edit_op_replaces_unique_match_and_reports_location() {
    let root = temp_root("edit-unique");
    let file = root.join("u.txt");
    fs::write(&file, "alpha\nbeta\ngamma\n").unwrap();
    let response = handle_request(&edit_request_line(&root, &file, "beta", "BETA", false));
    assert_eq!(response["ok"], json!(true), "实际: {response}");
    assert_eq!(response["replacements"], json!(1));
    assert_eq!(response["start_line"], json!(2));
    assert_eq!(response["end_line"], json!(2));
    assert_eq!(fs::read(&file).unwrap(), b"alpha\nBETA\ngamma\n");
    cleanup(&root);
}

#[test]
fn edit_op_reports_count_for_ambiguous_match_and_keeps_file() {
    let root = temp_root("edit-multi");
    let file = root.join("m.txt");
    fs::write(&file, "x\nx\nx\n").unwrap();
    let response = handle_request(&edit_request_line(&root, &file, "x", "y", false));
    assert_eq!(response["ok"], json!(false));
    let error = response["error"].as_str().unwrap();
    assert!(error.contains("匹配到 3 处"), "实际: {error}");
    assert_eq!(fs::read(&file).unwrap(), b"x\nx\nx\n");

    // replace_all 放行并报数量
    let response = handle_request(&edit_request_line(&root, &file, "x", "y", true));
    assert_eq!(response["ok"], json!(true), "实际: {response}");
    assert_eq!(response["replacements"], json!(3));
    assert_eq!(fs::read(&file).unwrap(), b"y\ny\ny\n");
    cleanup(&root);
}

#[test]
fn edit_op_rejects_empty_old_string_and_missing_file() {
    let root = temp_root("edit-guard");
    let file = root.join("g.txt");
    fs::write(&file, "keep\n").unwrap();
    let response = handle_request(&edit_request_line(&root, &file, "", "x", false));
    assert_eq!(response["ok"], json!(false));
    assert!(response["error"].as_str().unwrap().contains("old_string"));
    assert_eq!(fs::read(&file).unwrap(), b"keep\n");

    let missing = handle_request(&edit_request_line(
        &root,
        &root.join("ghost.txt"),
        "a",
        "b",
        false,
    ));
    assert_eq!(missing["ok"], json!(false));
    assert!(missing["error"].as_str().unwrap().contains("不存在"));

    let response = handle_request(r#"{"id":14,"op":"edit"}"#);
    assert_eq!(response["ok"], json!(false));
    assert!(response["error"].as_str().unwrap().contains("edit 请求字段有误"));
    cleanup(&root);
}

#[test]
fn edit_op_preserves_crlf_and_mixed_endings() {
    let root = temp_root("edit-endings");
    let file = root.join("e.txt");
    fs::write(&file, "one\r\ntwo\nthree\r\n").unwrap();
    let response = handle_request(&edit_request_line(&root, &file, "two", "TWO", false));
    assert_eq!(response["ok"], json!(true), "实际: {response}");
    assert_eq!(fs::read(&file).unwrap(), "one\r\nTWO\nthree\r\n".as_bytes());

    // 完全匹配不到时给缩进/空白差异提示
    let response = handle_request(&edit_request_line(&root, &file, "nope", "x", false));
    assert_eq!(response["ok"], json!(false));
    assert!(response["error"].as_str().unwrap().contains("缩进"));
    cleanup(&root);
}
