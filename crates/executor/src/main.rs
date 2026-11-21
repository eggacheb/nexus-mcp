//! nexus-mcp 执行器：唯一的命令执行层。
//!
//! 协议：stdin 收单行 JSON 请求，stdout 回单行 JSON 响应，一行一个请求。
//! 请求带自增 id（由协议层 TS 侧分配），响应原样带回 id。

mod head_tail_buffer;
mod string;

use std::fs;
use std::io::{BufRead, Read, Write, stdin, stdout};
use std::path::{Component, Path, PathBuf};
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
/// read 单次返回行数上限，与工具 schema 的 limit 上限一致（防御性重复）
const MAX_READ_LINES: u64 = 2_000;
/// read 的 max_output_bytes 缺省值，与配置 maxOutputBytes 的默认值一致
const DEFAULT_READ_MAX_OUTPUT_BYTES: u64 = 64 * 1024;

#[derive(Deserialize)]
struct ShellSpec {
    kind: String,
    program: String,
}

/// bash 请求体。op 分发在 handle_request 里完成，这里只管 bash 自己的字段。
#[derive(Deserialize)]
struct BashRequest {
    id: u64,
    command: String,
    cwd: String,
    timeout_ms: u64,
    max_output_bytes: usize,
    shell: ShellSpec,
}

/// read 请求体。path 由协议层解析成根目录内的绝对路径，root 是沙箱根；
/// 执行器仍做权威校验（词法 + 真实路径两道），不信任协议层的解析结果。
#[derive(Deserialize)]
struct ReadRequest {
    id: u64,
    path: String,
    root: String,
    offset: Option<u64>,
    limit: Option<u64>,
    #[serde(default = "default_read_max_output_bytes")]
    max_output_bytes: u64,
}

fn default_read_max_output_bytes() -> u64 {
    DEFAULT_READ_MAX_OUTPUT_BYTES
}

/// write 请求体。整文件覆盖写，内容按原样字节落盘（保留传入的换行风格）。
#[derive(Deserialize)]
struct WriteRequest {
    id: u64,
    path: String,
    root: String,
    content: String,
}

fn error_response(id: Option<u64>, message: impl Into<String>) -> Value {
    json!({ "id": id, "ok": false, "error": message.into() })
}

/// 处理一行请求，返回要写回的响应。独立成纯函数方便测试。
/// 先宽松解析拿 id/op：ping 是状态握手，不需要完整字段；
/// 各 op 再做严格反序列化，字段缺失在响应里给出可读错误。
fn handle_request(line: &str) -> Value {
    let parsed: Value = match serde_json::from_str(line) {
        Ok(value) => value,
        Err(err) => return error_response(None, format!("请求解析失败: {err}")),
    };
    let id = parsed.get("id").and_then(Value::as_u64);
    match parsed.get("op").and_then(Value::as_str) {
        Some("ping") => json!({ "id": id, "ok": true, "pong": true }),
        Some("bash") => match serde_json::from_value::<BashRequest>(parsed) {
            Ok(request) => run_bash(&request),
            Err(err) => error_response(id, format!("bash 请求字段有误: {err}")),
        },
        Some("read") => match serde_json::from_value::<ReadRequest>(parsed) {
            Ok(request) => run_read(&request),
            Err(err) => error_response(id, format!("read 请求字段有误: {err}")),
        },
        Some("write") => match serde_json::from_value::<WriteRequest>(parsed) {
            Ok(request) => run_write(&request),
            Err(err) => error_response(id, format!("write 请求字段有误: {err}")),
        },
        _ => error_response(id, "未知 op 或缺少 op"),
    }
}

fn run_bash(request: &BashRequest) -> Value {
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

/// 路径与根目录的包含关系。
enum Containment {
    /// 目标就是根目录本身
    RootItself,
    /// 在根目录内
    Inside,
    /// 越界
    Outside,
}

/// 判定 target 与 root 的关系。两个参数必须同一种形态（要么都经 canonicalize、
/// 要么都是词法形态），否则 `\\?\` verbatim 前缀差异会造成误判。
/// Windows 文件系统大小写不敏感，比较按小写进行。
fn classify(root: &Path, target: &Path) -> Containment {
    #[cfg(windows)]
    {
        let r = root.to_string_lossy().to_lowercase();
        let t = target.to_string_lossy().to_lowercase();
        if t == r {
            return Containment::RootItself;
        }
        let r_trimmed = r.trim_end_matches(['\\', '/']);
        if t.starts_with(r_trimmed) && t[r_trimmed.len()..].starts_with('\\') {
            return Containment::Inside;
        }
        Containment::Outside
    }
    #[cfg(not(windows))]
    {
        if target == root {
            return Containment::RootItself;
        }
        if target.starts_with(root) {
            return Containment::Inside;
        }
        Containment::Outside
    }
}

/// 词法规范化（不触碰文件系统）：处理 `.` 与 `..`。`..` 试图退回到根之前
/// （如 `D:\..`）视为越界返回 Err。执行器只应收到绝对路径，相对形态同样按越界拒绝。
fn lexical_normalize(path: &Path) -> Result<PathBuf, ()> {
    let mut normalized: Vec<Component> = Vec::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => match normalized.pop() {
                Some(Component::RootDir) | Some(Component::Prefix(_)) => return Err(()),
                Some(_) => {}
                None => return Err(()),
            },
            other => normalized.push(other),
        }
    }
    Ok(normalized.into_iter().collect())
}

/// 给模型看的路径：canonicalize 产出的 `\\?\` verbatim 前缀剥掉，短一些。
fn display_path(path: &Path) -> String {
    let s = path.to_string_lossy();
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{rest}");
    }
    if let Some(rest) = s.strip_prefix(r"\\?\") {
        return rest.to_string();
    }
    s.into_owned()
}

/// 越界拒绝的统一话术：带上被拒绝的原始输入、真实指向与根目录。
fn escape_error(input: &str, real: &Path, root: &Path) -> String {
    format!(
        "路径越界，拒绝访问: {input}（实际指向 {}，超出根目录 {}）",
        display_path(real),
        display_path(root)
    )
}

/// 沙箱校验第一道：词法检查。root 必须是词法形态（与 target 同形态，避免
/// 8.3 短路径与 verbatim 前缀差异造成误判）。目标不存在时（canonicalize
/// 不可用）也能给出「越界」而不是误导性的「文件不存在」。
fn ensure_lexically_within(
    root: &Path,
    input: &str,
    target: &Path,
) -> Result<PathBuf, String> {
    let normalized = lexical_normalize(target).map_err(|()| escape_error(input, target, root))?;
    match classify(root, &normalized) {
        Containment::Outside => Err(escape_error(input, &normalized, root)),
        _ => Ok(normalized),
    }
}

/// 根目录的两种形态：词法（与请求路径同形态比较，避开 8.3 短路径/verbatim 差异）
/// 与 canonicalize（符号链接解析后的真实路径）。
struct SandboxRoot {
    lexical: PathBuf,
    canonical: PathBuf,
}

/// 解析沙箱根目录，失败时返回可读的响应。
fn resolve_root(root: &str, id: Option<u64>) -> Result<SandboxRoot, Value> {
    let path = Path::new(root);
    let lexical = match lexical_normalize(path) {
        Ok(p) => p,
        Err(()) => return Err(error_response(id, format!("根目录路径无法解析: {root}"))),
    };
    let canonical = match fs::canonicalize(path) {
        Ok(p) => p,
        Err(err) => {
            return Err(error_response(
                id,
                format!("根目录不存在或不可访问: {} ({err})", display_path(path)),
            ));
        }
    };
    Ok(SandboxRoot { lexical, canonical })
}

/// 根目录本身不可写的统一话术。
fn root_not_writable_error(id: Option<u64>, root: &Path) -> Value {
    error_response(
        id,
        format!(
            "根目录本身不可写，write 只能写根目录内的文件: {}",
            display_path(root)
        ),
    )
}

fn run_read(request: &ReadRequest) -> Value {
    let id = Some(request.id);
    if request.path.trim().is_empty() {
        return error_response(id, "path 不能为空");
    }
    let root = match resolve_root(&request.root, id) {
        Ok(r) => r,
        Err(response) => return response,
    };
    let target = Path::new(&request.path);
    if let Err(message) = ensure_lexically_within(&root.lexical, &request.path, target) {
        return error_response(id, message);
    }
    let metadata = match fs::metadata(target) {
        Ok(m) => m,
        Err(_) => return error_response(id, format!("文件不存在: {}", request.path)),
    };
    if metadata.is_dir() {
        return error_response(id, format!("路径是目录，不是文件: {}", request.path));
    }
    // 真实路径校验：符号链接按解析结果判定，指向根外一律拒绝
    let canonical = match fs::canonicalize(target) {
        Ok(p) => p,
        Err(err) => return error_response(id, format!("路径解析失败: {} ({err})", request.path)),
    };
    if let Containment::Outside = classify(&root.canonical, &canonical) {
        return error_response(id, escape_error(&request.path, &canonical, &root.canonical));
    }

    let bytes = match fs::read(&canonical) {
        Ok(b) => b,
        Err(err) => return error_response(id, format!("读取文件失败: {} ({err})", request.path)),
    };
    let text = match String::from_utf8(bytes) {
        Ok(t) => t,
        Err(_) => return error_response(id, format!("文件不是有效的 UTF-8 文本，read 只支持 UTF-8 编码: {}", request.path)),
    };

    let lines: Vec<&str> = text.lines().collect();
    let total = lines.len() as u64;
    let offset = request.offset.unwrap_or(1).max(1);
    let limit = request.limit.unwrap_or(MAX_READ_LINES).clamp(1, MAX_READ_LINES);
    if offset > total {
        return json!({
            "id": request.id, "ok": true,
            "content": "", "total_lines": total,
            "start_line": 0, "end_line": 0, "omitted_lines": 0
        });
    }
    let selected_start = (offset - 1) as usize;
    let selected_end = (offset - 1).saturating_add(limit).min(total) as usize;

    // 逐行渲染行号；套字节上限：整行放得下就放，放不下先在字符边界截断当前行再停
    let max_bytes = request.max_output_bytes.max(1) as usize;
    let mut content = String::new();
    let mut rendered = 0usize;
    for (index, line) in lines[selected_start..selected_end].iter().enumerate() {
        let number = selected_start + index + 1;
        let piece = format!("{number:>6}\t{line}\n");
        if content.len() + piece.len() > max_bytes {
            if rendered == 0 {
                // 截断首行时预算要扣掉行号前缀与换行符，保证总输出不超上限
                let prefix = format!("{number:>6}\t");
                let budget = max_bytes
                    .saturating_sub(content.len())
                    .saturating_sub(prefix.len() + 1);
                content.push_str(&format!("{prefix}{}\n", truncated_prefix(line.as_bytes(), budget)));
                rendered = 1;
            }
            break;
        }
        content.push_str(&piece);
        rendered += 1;
    }
    let omitted = (selected_end - selected_start - rendered) as u64;
    let end_line = (selected_start + rendered) as u64;
    json!({
        "id": request.id, "ok": true,
        "content": content.trim_end_matches('\n').to_string(),
        "total_lines": total,
        "start_line": offset, "end_line": end_line,
        "omitted_lines": omitted
    })
}

fn run_write(request: &WriteRequest) -> Value {
    let id = Some(request.id);
    if request.path.trim().is_empty() {
        return error_response(id, "path 不能为空");
    }
    let root = match resolve_root(&request.root, id) {
        Ok(r) => r,
        Err(response) => return response,
    };
    let target = Path::new(&request.path);

    // 第一道：词法校验（含「目标就是根目录」的提前拒绝）
    let normalized = match lexical_normalize(target) {
        Ok(p) => p,
        Err(()) => return error_response(id, escape_error(&request.path, target, &root.lexical)),
    };
    match classify(&root.lexical, &normalized) {
        Containment::Outside => {
            return error_response(id, escape_error(&request.path, &normalized, &root.lexical));
        }
        Containment::RootItself => {
            return root_not_writable_error(id, &root.canonical);
        }
        Containment::Inside => {}
    }

    // 第二道：目标路径上已存在的东西按类型处理
    match fs::symlink_metadata(target) {
        Ok(meta) if meta.file_type().is_symlink() => {
            // 链接存在（含悬空）：按解析结果判定，解析失败就不猜
            match fs::canonicalize(target) {
                Ok(real) => {
                    if let Containment::Outside = classify(&root.canonical, &real) {
                        return error_response(id, escape_error(&request.path, &real, &root.canonical));
                    }
                    write_bytes(request, target)
                }
                Err(_) => error_response(
                    id,
                    format!("路径不可写: {} 是指向不存在目标的符号链接，拒绝写入", request.path),
                ),
            }
        }
        Ok(meta) if meta.is_dir() => {
            let canonical = fs::canonicalize(target).unwrap_or_else(|_| target.to_path_buf());
            if let Containment::RootItself = classify(&root.canonical, &canonical) {
                return root_not_writable_error(id, &root.canonical);
            }
            error_response(id, format!("目标路径是目录，不能作为文件写入: {}", request.path))
        }
        Ok(_) => {
            // 常规文件覆盖写：解析真实路径防中间链接偷换
            match fs::canonicalize(target) {
                Ok(real) => {
                    if let Containment::Outside = classify(&root.canonical, &real) {
                        return error_response(id, escape_error(&request.path, &real, &root.canonical));
                    }
                    write_bytes(request, target)
                }
                Err(err) => error_response(id, format!("路径解析失败: {} ({err})", request.path)),
            }
        }
        Err(_) => {
            // 目标不存在：父目录必须真实存在，不自动创建；落点按解析结果校验
            let Some(parent) = target.parent().filter(|p| !p.as_os_str().is_empty()) else {
                return error_response(id, format!("路径没有可写的文件名: {}", request.path));
            };
            let parent_canonical = match fs::canonicalize(parent) {
                Ok(p) => p,
                Err(_) => {
                    return error_response(
                        id,
                        format!("父目录不存在，write 不会自动创建目录: {}", display_path(parent)),
                    );
                }
            };
            let Some(name) = target.file_name() else {
                return error_response(id, format!("路径没有可写的文件名: {}", request.path));
            };
            let candidate = parent_canonical.join(name);
            match classify(&root.canonical, &candidate) {
                Containment::Outside => {
                    error_response(id, escape_error(&request.path, &candidate, &root.canonical))
                }
                Containment::RootItself => root_not_writable_error(id, &root.canonical),
                Containment::Inside => write_bytes(request, &candidate),
            }
        }
    }
}

/// 整文件覆盖写：内容原样字节落盘，UTF-8 编码，换行风格保持传入形态。
fn write_bytes(request: &WriteRequest, path: &Path) -> Value {
    match fs::write(path, request.content.as_bytes()) {
        Ok(()) => json!({
            "id": request.id, "ok": true,
            "bytes_written": request.content.len()
        }),
        Err(err) => error_response(
            Some(request.id),
            format!("写入文件失败: {} ({err})", request.path),
        ),
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
