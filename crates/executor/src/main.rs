//! nexus-mcp 执行器：唯一的命令执行层。
//!
//! 协议：stdin 收单行 JSON 请求，stdout 回单行 JSON 响应，一行一个请求。
//! 请求带自增 id（由协议层 TS 侧分配），响应原样带回 id。

mod head_tail_buffer;
mod string;

use std::io::{BufRead, Read, Write, stdin, stdout};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde::Deserialize;
use serde_json::{Value, json};

use head_tail_buffer::{HeadTailBuffer, format_output_omission_marker};
use string::{aligned_tail, truncated_prefix};

const MAX_TIMEOUT_MS: u64 = 600_000;
const POLL_INTERVAL_MS: u64 = 10;

#[derive(Deserialize)]
struct ShellSpec {
    kind: String,
    program: String,
}

/// bash 请求体。op 分发在 handle_request 里完成，这里只管 bash 自己的字段。
#[derive(Deserialize)]
struct Request {
    id: u64,
    command: String,
    cwd: String,
    timeout_ms: u64,
    max_output_bytes: usize,
    shell: ShellSpec,
}

fn error_response(id: Option<u64>, message: impl Into<String>) -> Value {
    json!({ "id": id, "ok": false, "error": message.into() })
}

/// 处理一行请求，返回要写回的响应。独立成纯函数方便测试。
/// 先宽松解析拿 id/op：ping 是状态握手，不需要 bash 的完整字段；
/// bash 再做严格反序列化，字段缺失在响应里给出可读错误。
fn handle_request(line: &str) -> Value {
    let parsed: Value = match serde_json::from_str(line) {
        Ok(value) => value,
        Err(err) => return error_response(None, format!("请求解析失败: {err}")),
    };
    let id = parsed.get("id").and_then(Value::as_u64);
    match parsed.get("op").and_then(Value::as_str) {
        Some("ping") => json!({ "id": id, "ok": true, "pong": true }),
        Some("bash") => match serde_json::from_value::<Request>(parsed) {
            Ok(request) => run_bash(&request),
            Err(err) => error_response(id, format!("bash 请求字段有误: {err}")),
        },
        _ => error_response(id, "未知 op 或缺少 op"),
    }
}

fn run_bash(request: &Request) -> Value {
    if request.command.trim().is_empty() {
        return error_response(Some(request.id), "command 不能为空");
    }
    if !Path::new(&request.cwd).is_dir() {
        return error_response(
            Some(request.id),
            format!("工作目录不存在或不是目录: {}", request.cwd),
        );
    }
    let max_bytes = request.max_output_bytes.max(1);
    let timeout_ms = request.timeout_ms.clamp(1, MAX_TIMEOUT_MS);

    let args: Vec<String> = match request.shell.kind.as_str() {
        // Git Bash：非登录模式，避免 profile 脚本改掉环境变量
        "git-bash" => vec!["-c".into(), request.command.clone()],
        // PowerShell 7：先强制控制台输出编码为 UTF-8，再跑命令
        "pwsh" => vec![
            "-NoProfile".into(),
            "-NonInteractive".into(),
            "-Command".into(),
            format!(
                "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; {}",
                request.command
            ),
        ],
        other => return error_response(Some(request.id), format!("不支持的 shell kind: {other}")),
    };

    let mut command = Command::new(&request.shell.program);
    command.args(&args).current_dir(&request.cwd);
    if request.shell.kind == "git-bash" {
        command
            .env("LANG", "zh_CN.UTF-8")
            .env("LC_ALL", "C.UTF-8")
            .env("MSYS_NO_PATHCONV", "1");
    }

    let mut child = match command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(child) => child,
        Err(err) => {
            return error_response(Some(request.id), format!("启动 {} 失败: {err}", request.shell.program));
        }
    };

    let stdout_stream = child.stdout.take().expect("stdout 已声明为 piped");
    let stderr_stream = child.stderr.take().expect("stderr 已声明为 piped");
    let buffer = Arc::new(Mutex::new(HeadTailBuffer::new(max_bytes)));
    let readers = spawn_readers(stdout_stream, stderr_stream, Arc::clone(&buffer));

    let deadline = Instant::now() + Duration::from_millis(timeout_ms);
    let mut timed_out = false;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {
                if Instant::now() >= deadline {
                    timed_out = true;
                    kill_process_tree(&mut child);
                    break;
                }
                thread::sleep(Duration::from_millis(POLL_INTERVAL_MS));
            }
            Err(err) => return error_response(Some(request.id), format!("等待子进程失败: {err}")),
        }
    }
    let status = match child.wait() {
        Ok(status) => status,
        Err(err) => return error_response(Some(request.id), format!("回收子进程失败: {err}")),
    };
    for reader in readers {
        let _ = reader.join();
    }

    let output = render_output(&mut buffer.lock().expect("输出缓冲锁不应中毒"));
    if timed_out {
        json!({ "id": request.id, "ok": true, "timed_out": true, "exit_code": Value::Null, "output": output })
    } else {
        json!({ "id": request.id, "ok": true, "exit_code": status.code().unwrap_or(-1), "output": output })
    }
}

/// stdout 与 stderr 各起一个线程，按到达顺序合并写进同一个有界缓冲。
fn spawn_readers(
    stdout_stream: impl Read + Send + 'static,
    stderr_stream: impl Read + Send + 'static,
    buffer: Arc<Mutex<HeadTailBuffer>>,
) -> Vec<thread::JoinHandle<()>> {
    vec![
        drain_stream(stdout_stream, Arc::clone(&buffer)),
        drain_stream(stderr_stream, buffer),
    ]
}

fn drain_stream<R: Read + Send + 'static>(
    mut stream: R,
    buffer: Arc<Mutex<HeadTailBuffer>>,
) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        let mut chunk = [0u8; 8192];
        loop {
            match stream.read(&mut chunk) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if let Ok(mut guard) = buffer.lock() {
                        guard.push_chunk(&chunk[..n]);
                    }
                }
            }
        }
    })
}

/// 终止整棵进程树。直接 kill 只杀得到外层 shell，bash 再派的子进程会留下来。
fn kill_process_tree(child: &mut Child) {
    #[cfg(windows)]
    {
        let _ = Command::new("taskkill")
            .args(["/PID", &child.id().to_string(), "/T", "/F"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    let _ = child.kill();
}

/// 把有界缓冲渲染成给模型看的文本：超限时保留头部与尾部，中间标注省略的字节数。
/// 头尾切点可能落在多字节字符中间，两端各丢掉不完整的碎字节，整段输出仍是合法 UTF-8。
fn render_output(buffer: &mut HeadTailBuffer) -> String {
    let omitted = buffer.omitted_bytes();
    if omitted == 0 {
        return String::from_utf8_lossy(&buffer.to_bytes()).into_owned();
    }
    let head = truncated_prefix(buffer.head_bytes(), buffer.head_budget());
    let tail = String::from_utf8_lossy(aligned_tail(buffer.tail_bytes())).into_owned();
    format!("{head}\n{}\n{tail}", format_output_omission_marker(omitted))
}

fn main() {
    let stdin = stdin();
    let stdout = stdout();
    let mut out = stdout.lock();
    for line in stdin.lock().lines() {
        let line = match line {
            Ok(line) => line,
            Err(_) => break,
        };
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let response = handle_request(trimmed);
        if writeln!(out, "{response}").and_then(|_| out.flush()).is_err() {
            break;
        }
    }
}

#[cfg(test)]
#[path = "main_tests.rs"]
mod tests;
