//! nexus-mcp 执行器：唯一的命令执行层。
//!
//! 协议：stdin 收单行 JSON 请求，stdout 回单行 JSON 响应，一行一个请求。
//! 请求带自增 id（由协议层 TS 侧分配），响应原样带回 id。

mod command_policy;
mod edit_match;
mod glob_search;
mod grep_search;
mod head_tail_buffer;
mod jobs;
mod ripgrep;
mod string;
#[cfg(windows)]
mod win_job;

use std::fs;
use std::io::{BufRead, Read, Write, stdin, stdout};
use std::path::{Component, Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, mpsc};
use std::thread;
use std::time::{Duration, Instant};

use serde::Deserialize;
use serde_json::{Value, json};

use head_tail_buffer::{HeadTailBuffer, format_output_omission_marker};
use string::{aligned_tail, truncated_prefix};

use edit_match::{
    CRLF, Match, find_occurrences, match_view, miss_hint, region_replacement,
};

const MAX_TIMEOUT_MS: u64 = 600_000;
const POLL_INTERVAL_MS: u64 = 10;
/// 协议层关闭 stdin 或父进程退出时由读线程置位，让阻塞中的同步 bash 立即感知并树杀收尾
static STDIN_CLOSED: AtomicBool = AtomicBool::new(false);
/// read 单次返回行数上限，与工具 schema 的 limit 上限一致（防御性重复）
const MAX_READ_LINES: u64 = 2_000;
/// read 的 max_output_bytes 缺省值，与配置 maxOutputBytes 的默认值一致
const DEFAULT_READ_MAX_OUTPUT_BYTES: u64 = 64 * 1024;

#[derive(Deserialize)]
pub struct ShellSpec {
    pub kind: String,
    pub program: String,
}

/// bash 请求体。op 分发在 handle_request 里完成，这里只管 bash 自己的字段。
/// policy 是命令闸门配置（config.json 的 commandPolicy），缺省时仅内置危险表生效。
#[derive(Deserialize)]
struct BashRequest {
    id: u64,
    command: String,
    root: String,
    #[serde(default)]
    cwd: String,
    timeout_ms: u64,
    max_output_bytes: usize,
    shell: ShellSpec,
    #[serde(default)]
    policy: Option<command_policy::CommandPolicySpec>,
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

/// edit 请求体。old_string → new_string 精确替换；匹配与行尾保真算法见 edit_match。
#[derive(Deserialize)]
struct EditRequest {
    id: u64,
    path: String,
    root: String,
    old_string: String,
    new_string: String,
    #[serde(default)]
    replace_all: bool,
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
        Some("edit") => match serde_json::from_value::<EditRequest>(parsed) {
            Ok(request) => run_edit(&request),
            Err(err) => error_response(id, format!("edit 请求字段有误: {err}")),
        },
        Some("glob") => match serde_json::from_value::<glob_search::GlobRequest>(parsed) {
            Ok(request) => glob_search::run_glob(&request),
            Err(err) => error_response(id, format!("glob 请求字段有误: {err}")),
        },
        Some("grep") => match serde_json::from_value::<grep_search::GrepRequest>(parsed) {
            Ok(request) => grep_search::run_grep(&request),
            Err(err) => error_response(id, format!("grep 请求字段有误: {err}")),
        },
        Some("job_start") => match serde_json::from_value::<jobs::JobStartRequest>(parsed) {
            Ok(request) => jobs::registry()
                .lock()
                .expect("任务注册表锁不应中毒")
                .start(&request),
            Err(err) => error_response(id, format!("job_start 请求字段有误: {err}")),
        },
        Some("job_output") => match serde_json::from_value::<jobs::JobOutputRequest>(parsed) {
            Ok(request) => jobs::registry()
                .lock()
                .expect("任务注册表锁不应中毒")
                .output(&request),
            Err(err) => error_response(id, format!("job_output 请求字段有误: {err}")),
        },
        Some("job_kill") => match serde_json::from_value::<jobs::JobKillRequest>(parsed) {
            Ok(request) => jobs::registry()
                .lock()
                .expect("任务注册表锁不应中毒")
                .kill(&request),
            Err(err) => error_response(id, format!("job_kill 请求字段有误: {err}")),
        },
        _ => error_response(id, "未知 op 或缺少 op"),
    }
}

/// bash 与 job_start 共用：校验 command/shell kind 并组装 Command（cwd 已由 resolve_work_dir 验根并还原为真实目录）。
fn build_shell_command(
    kind: &str,
    program: &str,
    command_line: &str,
    cwd: &Path,
) -> Result<Command, String> {
    if command_line.trim().is_empty() {
        return Err("command 不能为空".into());
    }
    let mut command = Command::new(program);
    match kind {
        // Git Bash：非登录模式，避免 profile 脚本改掉环境变量
        "git-bash" => {
            command.arg("-c").arg(command_line);
            command
                .env("LANG", "zh_CN.UTF-8")
                .env("LC_ALL", "C.UTF-8")
                .env("MSYS_NO_PATHCONV", "1");
        }
        // PowerShell 7：先强制控制台输出编码为 UTF-8，再跑命令
        "pwsh" => {
            command
                .arg("-NoProfile")
                .arg("-NonInteractive")
                .arg("-Command")
                .arg(format!(
                    "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; {command_line}"
                ));
        }
        other => return Err(format!("不支持的 shell kind: {other}")),
    }
    command.current_dir(cwd);
    Ok(command)
}

/// bash 与 job_start 共用的工作目录沙箱校验（词法 + canonicalize 真实路径两道），
/// 返回剥除 `\\?\` 前缀后的真实目录路径（避免 Windows 下 cmd/工具链拒绝 UNC verbatim 当前目录）。
pub(crate) fn resolve_work_dir(
    root_str: &str,
    cwd_str: &str,
    id: Option<u64>,
) -> Result<PathBuf, Value> {
    let root = resolve_root(root_str, id)?;
    let trimmed = cwd_str.trim();
    if trimmed.is_empty() {
        return Ok(PathBuf::from(display_path(&root.canonical)));
    }
    let canonical = resolve_existing_within_sandbox(
        &root,
        trimmed,
        SandboxEntryKind::Directory {
            missing_prefix: "工作目录不存在或不是目录",
            wrong_kind_prefix: "工作目录是文件不是目录",
            canonicalize_prefix: "工作目录解析失败",
        },
        id,
    )?;
    Ok(PathBuf::from(display_path(&canonical)))
}

fn run_bash(request: &BashRequest) -> Value {
    let max_bytes = request.max_output_bytes.max(1);
    let timeout_ms = request.timeout_ms.clamp(1, MAX_TIMEOUT_MS);

    // 命令闸门：内置危险表 + 白/黑名单，拒绝发生在 spawn 之前
    if let Some(response) = command_policy::gate(
        request.policy.as_ref(),
        &request.command,
        &request.shell.kind,
        Some(request.id),
    ) {
        return response;
    }

    let work_dir = match resolve_work_dir(&request.root, &request.cwd, Some(request.id)) {
        Ok(dir) => dir,
        Err(response) => return response,
    };

    let mut command = match build_shell_command(
        &request.shell.kind,
        &request.shell.program,
        &request.command,
        &work_dir,
    ) {
        Ok(command) => command,
        Err(message) => return error_response(Some(request.id), message),
    };

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
                if STDIN_CLOSED.load(Ordering::Acquire) || Instant::now() >= deadline {
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
#[derive(PartialEq)]
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

/// glob/grep 单次返回条目上限的默认值。
fn default_max_results() -> u64 {
    100
}

enum SandboxEntryKind {
    File,
    Directory {
        missing_prefix: &'static str,
        wrong_kind_prefix: &'static str,
        canonicalize_prefix: &'static str,
    },
}

/// 已存在路径的统一沙箱双道校验（词法越界检查 + metadata 类型核对 + canonicalize 真实路径验根）。
fn resolve_existing_within_sandbox(
    root: &SandboxRoot,
    input: &str,
    expected: SandboxEntryKind,
    id: Option<u64>,
) -> Result<PathBuf, Value> {
    let raw_target = Path::new(input);
    let target = if raw_target.is_absolute() {
        raw_target.to_path_buf()
    } else {
        root.lexical.join(raw_target)
    };
    if let Err(message) = ensure_lexically_within(&root.lexical, input, &target) {
        return Err(error_response(id, message));
    }
    let metadata = match fs::metadata(&target) {
        Ok(meta) => meta,
        Err(_) => {
            let prefix = match expected {
                SandboxEntryKind::File => "文件不存在",
                SandboxEntryKind::Directory { missing_prefix, .. } => missing_prefix,
            };
            return Err(error_response(id, format!("{prefix}: {input}")));
        }
    };
    let canonicalize_prefix = match expected {
        SandboxEntryKind::File => {
            if metadata.is_dir() {
                return Err(error_response(id, format!("路径是目录，不是文件: {input}")));
            }
            "路径解析失败"
        }
        SandboxEntryKind::Directory {
            wrong_kind_prefix,
            canonicalize_prefix,
            ..
        } => {
            if !metadata.is_dir() {
                return Err(error_response(id, format!("{wrong_kind_prefix}: {input}")));
            }
            canonicalize_prefix
        }
    };
    let canonical = match fs::canonicalize(&target) {
        Ok(path) => path,
        Err(err) => {
            return Err(error_response(
                id,
                format!("{canonicalize_prefix}: {input} ({err})"),
            ));
        }
    };
    if let Containment::Outside = classify(&root.canonical, &canonical) {
        return Err(error_response(id, escape_error(input, &canonical, &root.canonical)));
    }
    Ok(canonical)
}

/// glob/grep 共用：解析搜索起点（根目录或根内子目录），返回
/// (canonical 根目录, canonical 起点目录)。起点不存在或指向根外时给出可读错误。
/// 与 read/write 不同，起点允许是目录本身；但越界判定与文件操作同一套规矩。
fn resolve_search_dir(
    root_str: &str,
    path_str: Option<&str>,
    id: Option<u64>,
) -> Result<(PathBuf, PathBuf), Value> {
    let root = resolve_root(root_str, id)?;
    let Some(input) = path_str.map(str::trim).filter(|input| !input.is_empty()) else {
        return Ok((root.canonical.clone(), root.canonical));
    };
    let canonical = resolve_existing_within_sandbox(
        &root,
        input,
        SandboxEntryKind::Directory {
            missing_prefix: "搜索起点不存在或不是目录",
            wrong_kind_prefix: "搜索起点是文件不是目录，glob/grep 需要目录起点",
            canonicalize_prefix: "路径解析失败",
        },
        id,
    )?;
    Ok((root.canonical, canonical))
}

/// 结果路径的展示前缀：搜索起点相对沙箱根的路径（正斜杠）；起点就是根时为空串。
/// 统一以沙箱根为基准，模型可以把返回路径直接喂给 read/write。
fn display_rel_prefix(root_canonical: &Path, search_dir: &Path) -> String {
    search_dir
        .strip_prefix(root_canonical)
        .map(|rel| rel.to_string_lossy().replace('\\', "/"))
        .unwrap_or_default()
}

/// read 与 edit 共用的「存在性 + 沙箱两道校验」，返回 canonicalize 后的真实路径。
fn open_within_sandbox(root_str: &str, path_str: &str, id: Option<u64>) -> Result<PathBuf, Value> {
    if path_str.trim().is_empty() {
        return Err(error_response(id, "path 不能为空"));
    }
    let root = resolve_root(root_str, id)?;
    resolve_existing_within_sandbox(&root, path_str, SandboxEntryKind::File, id)
}

fn run_read(request: &ReadRequest) -> Value {
    let id = Some(request.id);
    let canonical = match open_within_sandbox(&request.root, &request.path, id) {
        Ok(p) => p,
        Err(response) => return response,
    };

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

    // 逐行渲染行号；套字节上限：整行放得下就放，放不下先在字符边界截断首行并报告被裁字节数再停
    let max_bytes = request.max_output_bytes.max(1) as usize;
    let mut content = String::new();
    let mut rendered = 0usize;
    let mut truncated_line_bytes: u64 = 0;
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
                let shown = truncated_prefix(line.as_bytes(), budget);
                truncated_line_bytes = line.len().saturating_sub(shown.len()) as u64;
                content.push_str(&format!("{prefix}{shown}\n"));
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
        "omitted_lines": omitted,
        "truncated_line_bytes": truncated_line_bytes
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

/// edit op：old_string → new_string 精确替换。只在唯一匹配（或 replace_all）时
/// 动手；匹配、行尾保真与失败提示见 edit_match 模块。只支持已存在的 UTF-8 文件。
fn run_edit(request: &EditRequest) -> Value {
    let id = Some(request.id);
    if request.old_string.is_empty() {
        return error_response(id, "old_string 不能为空；创建或覆盖整个文件请用 write");
    }
    if request.old_string == request.new_string {
        return error_response(id, "old_string 与 new_string 相同，没有可应用的改动");
    }
    let canonical = match open_within_sandbox(&request.root, &request.path, id) {
        Ok(p) => p,
        Err(response) => return response,
    };
    let bytes = match fs::read(&canonical) {
        Ok(b) => b,
        Err(err) => return error_response(id, format!("读取文件失败: {} ({err})", request.path)),
    };
    let source = match String::from_utf8(bytes) {
        Ok(t) => t,
        Err(_) => {
            return error_response(
                id,
                format!("文件不是有效的 UTF-8 文本，edit 只支持 UTF-8 编码: {}", request.path),
            )
        }
    };

    // 只差 \r 的请求是在改行尾本身，按原样字节处理；其余都走 LF 视图匹配
    let endings_only =
        request.old_string.replace('\r', "") == request.new_string.replace('\r', "");
    let matches: Vec<Match> = if endings_only {
        find_occurrences(&source, &request.old_string)
    } else {
        match_view(&source, &request.old_string)
    };
    let replacements = matches.len();
    if replacements == 0 {
        let mut message = format!(
            "在 {} 中找不到 old_string，可能是缩进或空白差异（old_string 必须与文件内容完全一致，包括缩进）。",
            request.path
        );
        if let Some(hint) = miss_hint(&source, &request.old_string, &request.new_string) {
            message.push_str(&format!("\n\n{hint}"));
        }
        return error_response(id, message);
    }
    if replacements > 1 && !request.replace_all {
        return error_response(
            id,
            format!(
                "old_string 匹配到 {replacements} 处，要求唯一。请补充上下文让它只匹配一处，或把 replace_all 设为 true 替换全部。"
            ),
        );
    }
    let replacement_lf = request.new_string.replace(CRLF, "\n");
    let mut replaced = source.clone();
    let selected = if request.replace_all {
        &matches[..]
    } else {
        &matches[..1]
    };
    // 倒序替换，前面的偏移不受影响
    for matched in selected.iter().rev() {
        let text = if endings_only {
            request.new_string.clone()
        } else {
            region_replacement(&source, matched, &replacement_lf)
        };
        replaced.replace_range(matched.start..matched.end, &text);
    }
    if replaced == source {
        return error_response(
            id,
            if endings_only {
                format!("没有可应用的改动: {} 已经是这些行尾了。", request.path)
            } else {
                format!(
                    "没有可应用的改动: 这次编辑不会改变 {} 的内容。行尾跟随原文件；要改行尾本身，请在 old_string 或 new_string 里显式写 \\r。",
                    request.path
                )
            },
        );
    }
    if let Err(err) = fs::write(&canonical, replaced.as_bytes()) {
        return error_response(id, format!("写入文件失败: {} ({err})", request.path));
    }
    // 改动位置：首处匹配在原文件里的行号（与 read 的行号一致）
    let first = &matches[0];
    let mut end_line = line_number_at(&source, first.end);
    if source[first.start..first.end].ends_with('\n') {
        end_line -= 1;
    }
    json!({
        "id": request.id, "ok": true,
        "replacements": replacements,
        "start_line": line_number_at(&source, first.start),
        "end_line": end_line,
        "total_lines": replaced.lines().count()
    })
}

/// 字节偏移所在的行号（1 起）。offset 必须落在字符边界上（匹配区间保证如此）。
fn line_number_at(text: &str, offset: usize) -> u64 {
    text.as_bytes()[..offset]
        .iter()
        .filter(|&&b| b == b'\n')
        .count() as u64
        + 1
}

/// stdout 与 stderr 各起一个线程，按到达顺序合并写进同一个有界缓冲。
fn spawn_readers(
    stdout_stream: impl Read + Send + 'static,
    stderr_stream: impl Read + Send + 'static,
    buffer: Arc<Mutex<HeadTailBuffer>>,
) -> Vec<thread::JoinHandle<()>> {
    vec![
        drain_stream(stdout_stream, Arc::clone(&buffer), None),
        drain_stream(stderr_stream, buffer, None),
    ]
}

/// 泵一个输出流到有界缓冲，读尽（EOF/错误）后发一次完成信号。
/// bash 等待用不到信号传 None（直接 join）；后台任务的监控线程
/// 用信号在宽限内判断泵是否收尾，避免被握着管道的泄漏孙进程卡住。
fn drain_stream<R: Read + Send + 'static>(
    mut stream: R,
    buffer: Arc<Mutex<HeadTailBuffer>>,
    done: Option<mpsc::Sender<()>>,
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
        if let Some(done) = done {
            let _ = done.send(());
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
    let (tx, rx) = mpsc::channel::<String>();
    thread::spawn(move || {
        let stdin = stdin();
        for line in stdin.lock().lines() {
            match line {
                Ok(line) => {
                    if tx.send(line).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
        STDIN_CLOSED.store(true, Ordering::Release);
    });

    let stdout = stdout();
    let mut out = stdout.lock();
    while let Ok(line) = rx.recv() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let response = handle_request(trimmed);
        if STDIN_CLOSED.load(Ordering::Acquire) {
            break;
        }
        if writeln!(out, "{response}").and_then(|_| out.flush()).is_err() {
            STDIN_CLOSED.store(true, Ordering::Release);
            break;
        }
    }
    // stdin EOF 或写响应失败意味着协议层已离开：终止所有还在跑的后台任务，
    // 不留孤儿进程（Windows 侧另有 Job Object 兜底，见 win_job）
    jobs::registry()
        .lock()
        .expect("任务注册表锁不应中毒")
        .kill_all_running();
}

#[cfg(test)]
#[path = "main_tests.rs"]
mod tests;
