//! nexus-mcp 执行器：唯一的命令执行层。
//!
//! 协议：stdin 收单行 JSON 请求，stdout 回单行 JSON 响应，一行一个请求。
//! 请求带自增 id（由协议层 TS 侧分配），响应原样带回 id。

mod command_policy;
mod edit_match;
mod file_lock;
mod glob_search;
mod grep_search;
mod head_tail_buffer;
mod jobs;
mod ripgrep;
mod sandbox;
mod string;
#[cfg(windows)]
mod win_job;

use std::collections::VecDeque;
use std::fs;
use std::io::{BufRead, Read, Write, stdin, stdout};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, mpsc};
use std::thread;
use std::time::{Duration, Instant};

use serde::Deserialize;
use serde_json::{Value, json};

use head_tail_buffer::{HeadTailBuffer, format_output_omission_marker};
use sandbox::{open_within_sandbox, resolve_work_dir, resolve_write_target};
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
    offset: Option<i64>,
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
            Ok(request) => jobs::handle_output(&request),
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
    // 面向模型消费的非 TTY 管道默认关闭 ANSI 彩色转义，减少输出噪声
    command.env("NO_COLOR", "1");
    command.current_dir(cwd);
    Ok(command)
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

/// glob/grep 单次返回条目上限的默认值。
fn default_max_results() -> u64 {
    100
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
    let raw_offset = request.offset.unwrap_or(1);
    if raw_offset == 0 {
        return error_response(id, "offset 不能为 0（正数从 1 开始，负数表示从文件末尾倒数）");
    }
    let offset: u64 = if raw_offset < 0 {
        total.saturating_sub(raw_offset.unsigned_abs()) + 1
    } else {
        raw_offset as u64
    };
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
    let target = match resolve_write_target(&request.root, &request.path, Some(request.id)) {
        Ok(t) => t,
        Err(response) => return response,
    };
    let _guard = file_lock::acquire(&target.lock_path);
    write_bytes(request, &target.write_path)
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
    let _guard = file_lock::acquire(&canonical);
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
        let shown: Vec<String> = matches
            .iter()
            .take(10)
            .map(|m| line_number_at(&source, m.start).to_string())
            .collect();
        let suffix = if replacements > 10 { " 等" } else { "" };
        return error_response(
            id,
            format!(
                "old_string 匹配到 {replacements} 处（第 {} 行{suffix}），要求唯一。请补充上下文让它只匹配一处，或把 replace_all 设为 true 替换全部。",
                shown.join("、")
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

/// 双车道各自默认最大并发工作线程数（ADR-0011）
const DEFAULT_LANE_MAX_WORKERS: usize = 16;

/// 判断请求是否归入 control 车道：ping、job_kill 以及无等待的 job_output，
/// 独立于 ordinary 车道，确保慢请求打满槽位时不会饿死控制与健康指令。
fn is_control_request(line: &str) -> bool {
    let Ok(parsed) = serde_json::from_str::<Value>(line) else {
        return true;
    };
    match parsed.get("op").and_then(Value::as_str) {
        Some("ping") | Some("job_kill") => true,
        Some("job_output") => parsed.get("wait_ms").and_then(Value::as_u64).unwrap_or(0) == 0,
        _ => false,
    }
}

struct LaneState {
    queue: VecDeque<String>,
    active_workers: usize,
    idle_workers: usize,
    closed: bool,
}

/// 纯标准库惰性线程池：按需拉起最多 `max_workers` 条工作线程，所有响应经 `out_tx` 顺序写回。
struct LanePool {
    shared: Arc<(Mutex<LaneState>, Condvar)>,
    max_workers: usize,
    out_tx: mpsc::Sender<Value>,
    handles: Mutex<Vec<thread::JoinHandle<()>>>,
}

impl LanePool {
    fn new(max_workers: usize, out_tx: mpsc::Sender<Value>) -> Self {
        Self {
            shared: Arc::new((
                Mutex::new(LaneState {
                    queue: VecDeque::new(),
                    active_workers: 0,
                    idle_workers: 0,
                    closed: false,
                }),
                Condvar::new(),
            )),
            max_workers: max_workers.max(1),
            out_tx,
            handles: Mutex::new(Vec::new()),
        }
    }

    fn submit(&self, line: String) {
        let should_spawn = {
            let (lock, cvar) = &*self.shared;
            let mut state = lock.lock().expect("车道锁不应中毒");
            if state.closed {
                return;
            }
            state.queue.push_back(line);
            let spawn = state.idle_workers == 0 && state.active_workers < self.max_workers;
            if spawn {
                state.active_workers += 1;
            }
            cvar.notify_one();
            spawn
        };
        if should_spawn {
            let shared = Arc::clone(&self.shared);
            let out_tx = self.out_tx.clone();
            let handle = thread::spawn(move || {
                let (lock, cvar) = &*shared;
                loop {
                    let task = {
                        let mut state = lock.lock().expect("车道锁不应中毒");
                        loop {
                            if let Some(line) = state.queue.pop_front() {
                                break Some(line);
                            }
                            if state.closed {
                                state.active_workers = state.active_workers.saturating_sub(1);
                                break None;
                            }
                            state.idle_workers += 1;
                            state = cvar.wait(state).expect("车道条件变量不应中毒");
                            state.idle_workers = state.idle_workers.saturating_sub(1);
                        }
                    };
                    let Some(line) = task else {
                        break;
                    };
                    let response = handle_request(&line);
                    if STDIN_CLOSED.load(Ordering::Acquire) {
                        break;
                    }
                    if out_tx.send(response).is_err() {
                        break;
                    }
                }
            });
            if let Ok(mut handles) = self.handles.lock() {
                handles.push(handle);
            }
        }
    }

    fn shutdown(&self) {
        {
            let (lock, cvar) = &*self.shared;
            let mut state = lock.lock().expect("车道锁不应中毒");
            state.closed = true;
            state.queue.clear();
            cvar.notify_all();
        }
        if let Ok(mut handles) = self.handles.lock() {
            for handle in handles.drain(..) {
                let _ = handle.join();
            }
        }
    }
}

fn main() {
    let (out_tx, out_rx) = mpsc::channel::<Value>();
    let writer = thread::spawn(move || {
        let stdout = stdout();
        let mut out = stdout.lock();
        while let Ok(response) = out_rx.recv() {
            if STDIN_CLOSED.load(Ordering::Acquire) {
                break;
            }
            if writeln!(out, "{response}").and_then(|_| out.flush()).is_err() {
                STDIN_CLOSED.store(true, Ordering::Release);
                break;
            }
        }
    });

    let control_lane = LanePool::new(DEFAULT_LANE_MAX_WORKERS, out_tx.clone());
    let ordinary_lane = LanePool::new(DEFAULT_LANE_MAX_WORKERS, out_tx.clone());

    let stdin = stdin();
    for line in stdin.lock().lines() {
        match line {
            Ok(line) => {
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                if is_control_request(trimmed) {
                    control_lane.submit(trimmed.to_string());
                } else {
                    ordinary_lane.submit(trimmed.to_string());
                }
            }
            Err(_) => break,
        }
    }

    // stdin EOF 或写响应失败意味着协议层已离开：置位通知在途 bash 收尾并等待工作线程退出，
    // 再统一树杀所有仍在跑的后台任务，不留孤儿进程（Windows 侧另有 Job Object 兜底，见 win_job）
    STDIN_CLOSED.store(true, Ordering::Release);
    control_lane.shutdown();
    ordinary_lane.shutdown();
    drop(out_tx);
    let _ = writer.join();
    jobs::registry()
        .lock()
        .expect("任务注册表锁不应中毒")
        .kill_all_running();
}

#[cfg(test)]
#[path = "main_tests.rs"]
mod tests;
