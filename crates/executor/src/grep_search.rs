//! grep op：调用 ripgrep（`--json`）返回文件名、行号与匹配行内容。
//!
//! args 组合照搬 opencode `core/src/ripgrep.ts`：`--no-config --json --hidden
//! --no-messages`，附加 `--glob=!**/.git/**` 排除 .git 自身；截断采用
//! 「读到上限 +1 条就终止进程」的做法。不自己实现文件遍历。
//! 二进制文件由 rg 自身的 NUL 字节检测跳过，不会把乱码塞进结果。

use std::io::{BufRead, BufReader, Read};
use std::process::{Command, Stdio};
use std::thread;

use base64::Engine as _;
use serde::Deserialize;
use serde_json::{Value, json};

use super::ripgrep::resolve_rg;
use super::{GrepTarget, default_max_results, display_rel_prefix, error_response, resolve_grep_target};

/// 单行内容的字符数上限，对齐 opencode 的 MAX_LINE_CHARS
const MAX_LINE_CHARS: usize = 2_000;

#[derive(Deserialize)]
pub struct GrepRequest {
    id: u64,
    root: String,
    path: Option<String>,
    pattern: String,
    glob: Option<String>,
    #[serde(default)]
    ignore_case: bool,
    #[serde(default = "default_max_results")]
    max_results: u64,
}

pub fn run_grep(request: &GrepRequest) -> Value {
    let id = Some(request.id);
    // 只拦全空白，pattern 原样下发：首尾空格是合法正则语义，trim 会改语义
    if request.pattern.trim().is_empty() {
        return error_response(id, "pattern 不能为空");
    }
    let max_results = request.max_results.clamp(1, 1000);
    let (root_canonical, target) =
        match resolve_grep_target(&request.root, request.path.as_deref(), id) {
            Ok(pair) => pair,
            Err(response) => return response,
        };
    let (search_dir, target_arg) = match target {
        GrepTarget::File(file_path) => {
            let parent = file_path
                .parent()
                .map(std::path::Path::to_path_buf)
                .unwrap_or_else(|| root_canonical.clone());
            let name = file_path
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| ".".into());
            (parent, name)
        }
        GrepTarget::Dir(dir_path) => (dir_path, ".".into()),
    };
    let rg = match resolve_rg() {
        Ok(path) => path,
        Err(message) => return error_response(id, message),
    };

    let mut args: Vec<String> = vec![
        "--no-config".into(),
        "--json".into(),
        "--hidden".into(),
        "--no-messages".into(),
    ];
    if request.ignore_case {
        args.push("--ignore-case".into());
    }
    if let Some(glob) = request.glob.as_deref().map(str::trim).filter(|glob| !glob.is_empty()) {
        args.push(format!("--glob={glob}"));
    }
    args.push("--glob=!**/.git/**".into());
    args.push("--".into());
    args.push(request.pattern.clone());
    args.push(target_arg);

    let mut child = match Command::new(&rg)
        .args(&args)
        .current_dir(&search_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(child) => child,
        Err(err) => return error_response(id, format!("启动 ripgrep 失败: {err}")),
    };
    let stdout = child.stdout.take().expect("stdout 已声明为 piped");
    let stderr_stream = child.stderr.take().expect("stderr 已声明为 piped");
    let stderr_handle = thread::spawn(move || {
        let mut text = String::new();
        let mut reader = BufReader::new(stderr_stream);
        let _ = reader.read_to_string(&mut text);
        text
    });

    let prefix = display_rel_prefix(&root_canonical, &search_dir);
    let mut matches: Vec<Value> = Vec::new();
    let mut truncated = false;
    let mut reader = BufReader::new(stdout);
    let mut raw: Vec<u8> = Vec::new();
    loop {
        raw.clear();
        match reader.read_until(b'\n', &mut raw) {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
        let line = String::from_utf8_lossy(&raw);
        let Ok(event) = serde_json::from_str::<Value>(line.trim()) else {
            continue;
        };
        if event.get("type").and_then(Value::as_str) != Some("match") {
            continue;
        }
        if matches.len() >= max_results as usize {
            truncated = true;
            let _ = child.kill();
            break;
        }
        if let Some(data) = event.get("data") {
            if let Some(row) = parse_match_row(data, &prefix) {
                matches.push(row);
            }
        }
    }
    let stderr_text = stderr_handle.join().unwrap_or_default();
    if truncated {
        let _ = child.wait();
    } else {
        match child.wait() {
            // rg 退出码约定：0 有匹配，1 无匹配，2 出错。个别文件的遍历错误
            // （权限、悬空链接等）也让 rg 以 2 收场——`--no-messages` 会吞掉
            // 这些 stderr。只有参数本身被拒（正则/glob 语法）才把整次搜索
            // 当失败；其余按 opencode 的口径容错，返回已收集到的结果。
            Ok(status) if status.code() == Some(2) => {
                if is_rg_argument_error(&stderr_text) {
                    return error_response(id, diagnose_rg_error(&stderr_text));
                }
            }
            Ok(_) => {}
            Err(err) => return error_response(id, format!("等待 ripgrep 退出失败: {err}")),
        }
    }

    json!({
        "id": request.id, "ok": true,
        "matches": matches,
        "truncated": truncated,
    })
}

/// rg 的 JSON 载荷字段：正常是 `text`，非 UTF-8 行是 base64 的 `bytes`
/// （rg 对非法 UTF-8 数据走 base64，解码后按 UTF-8 宽松处理）。
fn decode_payload(value: &Value) -> Option<String> {
    let object = value.as_object()?;
    if let Some(text) = object.get("text").and_then(Value::as_str) {
        return Some(text.to_string());
    }
    let encoded = object.get("bytes").and_then(Value::as_str)?;
    let decoded = base64::engine::general_purpose::STANDARD.decode(encoded).ok()?;
    Some(String::from_utf8_lossy(&decoded).into_owned())
}

/// match 事件 → { path, line, text }。路径统一成相对沙箱根、正斜杠，
/// rg 以 `.` 为搜索路径时输出带 `./`（Windows 下 `.\`）前缀，一并剥掉。
fn parse_match_row(data: &Value, prefix: &str) -> Option<Value> {
    let raw_path = decode_payload(data.get("path")?)?;
    let line_number = data.get("line_number")?.as_u64()?;
    let raw_line = decode_payload(data.get("lines")?)?;
    let rel = raw_path
        .strip_prefix("./")
        .or_else(|| raw_path.strip_prefix(".\\"))
        .unwrap_or(&raw_path)
        .replace('\\', "/");
    let display = if prefix.is_empty() { rel } else { format!("{prefix}/{rel}") };
    Some(json!({
        "path": display,
        "line": line_number,
        "text": clamp_line(&raw_line),
    }))
}

/// rg 给的行带行尾换行，剥掉后按字符数截断（截断点必在字符边界上）。
fn clamp_line(raw: &str) -> String {
    let line = raw.trim_end_matches(['\n', '\r']);
    if line.chars().count() > MAX_LINE_CHARS {
        format!("{}...", line.chars().take(MAX_LINE_CHARS).collect::<String>())
    } else {
        line.to_string()
    }
}

/// rg 退出码 2 时区分「参数被拒」与「遍历容错」：只有参数错误（正则/glob
/// 语法、未知参数）才值得把整次搜索当失败。`--no-messages` 只吞遍历类
/// stderr，参数错误一定落在 stderr 上。
fn is_rg_argument_error(stderr: &str) -> bool {
    let lowered = stderr.to_lowercase();
    lowered.contains("regex parse error")
        || lowered.contains("error parsing regex")
        || lowered.contains("error parsing glob")
        || lowered.contains("unrecognized")
}

/// 参数被拒时把 stderr 原样透出方便改参数。
fn diagnose_rg_error(stderr: &str) -> String {
    let trimmed = stderr.trim();
    if trimmed.is_empty() {
        "ripgrep 异常退出（退出码 2）。请检查 pattern 是否是合法正则、glob 参数是否正确。".to_string()
    } else {
        format!("ripgrep 拒绝了搜索参数: {trimmed}")
    }
}
