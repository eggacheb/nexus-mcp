//! 后台任务：`job_start` 立刻返回 id，进程与输出都由执行器内存管；
//! `job_output` 按字节偏移增量读有界缓冲，结束后可反复查询退出码。
//!
//! 进程事件模型对照 codex exec-server 的 `ExecProcess`/`ExecProcessEvent`/
//! `ProcessOutputChunk` 形状（见 docs/research/codex-reusable-parts.md §2.6），
//! 不引入那个 crate；输出缓冲复用票 03 搬进来的 `head-tail-buffer`。
//! Windows 侧树终止由 `win_job` 的 Job Object 加固。

use std::collections::{HashMap, VecDeque};
use std::process::{Child, Command, Stdio};
use std::sync::{mpsc, Arc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

use serde::Deserialize;
use serde_json::{Value, json};

use crate::head_tail_buffer::{HeadTailBuffer, format_output_omission_marker};
use crate::string::{aligned_tail, decode_lossy_stream, utf8_straddle_skip};

/// job 输出缓冲与单次读取的缺省字节上限，与配置 maxOutputBytes 默认一致
const DEFAULT_JOB_MAX_OUTPUT_BYTES: u64 = 64 * 1024;
/// 完成任务记录的保留上限；超出时从最早的开始淘汰，防止长时间运行累积内存
const MAX_FINISHED_JOBS: usize = 50;
/// 子进程退出后等输出泵收尾的宽限；等不到就不再等（泄漏的孙进程握着管道时
/// 不能一直卡住退出状态），残留输出会在记录淘汰或服务退出时随管道关闭补齐
const READER_GRACE_MS: u64 = 500;

/// job_output 短等待上限（30 秒，安全低于云端连接器 HTTP 超时）
const MAX_JOB_WAIT_MS: u64 = 30_000;
/// 运行中出现新输出后的合并防抖窗口，避免把刷屏日志拆成几十次零碎返回
const WAIT_DEBOUNCE_MS: u64 = 200;
/// 短等待轮询步长
const WAIT_POLL_MS: u64 = 20;

fn default_job_max_output_bytes() -> u64 {
    DEFAULT_JOB_MAX_OUTPUT_BYTES
}

/// policy 是命令闸门配置（config.json 的 commandPolicy），缺省时仅内置危险表生效。
#[derive(Deserialize)]
pub struct JobStartRequest {
    pub id: u64,
    pub command: String,
    pub root: String,
    #[serde(default)]
    pub cwd: String,
    pub max_output_bytes: u64,
    pub shell: crate::ShellSpec,
    #[serde(default)]
    pub policy: Option<crate::command_policy::CommandPolicySpec>,
}

#[derive(Deserialize)]
pub struct JobOutputRequest {
    pub id: u64,
    pub job_id: String,
    pub offset: Option<u64>,
    #[serde(default = "default_job_max_output_bytes")]
    pub max_output_bytes: u64,
    #[serde(default)]
    pub wait_ms: Option<u64>,
    #[serde(default)]
    pub wait_for_exit: bool,
}

/// 终止不需要 force/graceful 开关：Windows 侧两侧保险都是硬杀，协议里没有软信号通道。
#[derive(Deserialize)]
pub struct JobKillRequest {
    pub id: u64,
    pub job_id: String,
}

/// 任务状态。Running 期间子进程由监控线程盯着；Exited 后只留有界缓冲与退出码。
#[derive(Clone, Copy)]
enum JobState {
    Running,
    Exited { exit_code: i32, elapsed_ms: u64 },
}

/// 任务记录。Arc 共享：注册表管生死，监控线程写状态，output() 读缓冲。
struct Job {
    started_at: Instant,
    buffer: Arc<Mutex<HeadTailBuffer>>,
    /// Child 放在锁里：监控线程轮询 try_wait，注册表退出清理时借用来杀树
    child: Mutex<Child>,
    /// 输出泵的完成信号（stdout/stderr 各一个），监控线程在宽限内等它们
    reader_done: Mutex<Vec<mpsc::Receiver<()>>>,
    state: Mutex<JobState>,
    /// Windows kill-on-close job：执行器进程怎么死，OS 都会把整棵树带走
    #[cfg(windows)]
    job_object: Option<crate::win_job::JobObject>,
    /// 非 Windows 平台的占位，让构造逻辑不分支
    #[cfg(not(windows))]
    _job_guard: JobGuard,
}

impl Job {
    /// 杀掉整棵进程树：Windows 先 TerminateJobObject（覆盖已入 job 的后代），
    /// 再走 taskkill /T /F + kill 兜底（与 bash 超时同一套 kill_process_tree）。
    fn terminate_tree(&self) {
        #[cfg(windows)]
        if let Some(job_object) = &self.job_object {
            job_object.terminate();
        }
        let Ok(mut child) = self.child.lock() else {
            return;
        };
        crate::kill_process_tree(&mut child);
    }
}

#[cfg(windows)]
type JobGuard = Option<crate::win_job::JobObject>;
#[cfg(not(windows))]
type JobGuard = ();

#[cfg(windows)]
fn spawn_job_child(command: Command) -> std::io::Result<(Child, JobGuard)> {
    crate::win_job::JobObject::spawn_managed(command)
}

#[cfg(not(windows))]
fn spawn_job_child(mut command: Command) -> std::io::Result<(Child, JobGuard)> {
    Ok((command.spawn()?, ()))
}

/// 任务注册表。单线程访问（主循环串行处理请求 + 退出清理），内部只放轻同步。
pub struct JobRegistry {
    next_id: u64,
    jobs: HashMap<u64, Arc<Job>>,
    /// 已退出任务的 id，按发现顺序排队，超出上限时从队首淘汰
    finished: VecDeque<u64>,
}

impl JobRegistry {
    pub fn new() -> Self {
        Self {
            next_id: 0,
            jobs: HashMap::new(),
            finished: VecDeque::new(),
        }
    }

    /// 启动后台任务：命令闸门校验 + spawn + 挂监控线程，立刻返回 job_id，不等待命令。
    pub fn start(&mut self, request: &JobStartRequest) -> Value {
        let id = Some(request.id);
        // 命令闸门：与 bash 同一套判定，拒绝发生在 spawn 之前
        if let Some(response) = crate::command_policy::gate(
            request.policy.as_ref(),
            &request.command,
            &request.shell.kind,
            id,
        ) {
            return response;
        }
        let work_dir = match crate::sandbox::resolve_work_dir(&request.root, &request.cwd, id) {
            Ok(dir) => dir,
            Err(response) => return response,
        };
        let command = match crate::build_shell_command(
            &request.shell.kind,
            &request.shell.program,
            &request.command,
            &work_dir,
        ) {
            Ok(command) => command,
            Err(message) => return crate::error_response(id, message),
        };
        self.reconcile_finished();

        let mut command = command;
        command
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let (mut child, job_guard) = match spawn_job_child(command) {
            Ok(pair) => pair,
            Err(err) => {
                return crate::error_response(
                    id,
                    format!("启动 {} 失败: {err}", request.shell.program),
                );
            }
        };
        let pid = child.id();

        self.next_id += 1;
        let job_id = self.next_id;
        let buffer = Arc::new(Mutex::new(HeadTailBuffer::new(
            request.max_output_bytes.max(1) as usize,
        )));

        // stdout/stderr 各起一个输出泵并入同一个有界缓冲，完成时发信号
        let stdout_stream = child.stdout.take().expect("stdout 已声明为 piped");
        let stderr_stream = child.stderr.take().expect("stderr 已声明为 piped");
        let (stdout_tx, stdout_rx) = mpsc::channel();
        let (stderr_tx, stderr_rx) = mpsc::channel();
        crate::drain_stream(stdout_stream, Arc::clone(&buffer), Some(stdout_tx));
        crate::drain_stream(stderr_stream, Arc::clone(&buffer), Some(stderr_tx));

        let job = Arc::new(Job {
            started_at: Instant::now(),
            buffer,
            child: Mutex::new(child),
            reader_done: Mutex::new(vec![stdout_rx, stderr_rx]),
            state: Mutex::new(JobState::Running),
            #[cfg(windows)]
            job_object: job_guard,
            #[cfg(not(windows))]
            _job_guard: job_guard,
        });
        self.jobs.insert(job_id, Arc::clone(&job));
        thread::spawn(move || monitor(job));

        json!({
            "id": request.id, "ok": true,
            "job_id": format!("job-{job_id}"),
            "pid": pid,
        })
    }

    /// 读取任务输出（测试便捷入口；生产路径走 `handle_output` 在等待前释放注册表锁）。
    #[cfg(test)]
    pub fn output(&mut self, request: &JobOutputRequest) -> Value {
        let id = Some(request.id);
        let job = match self.resolve_job(id, &request.job_id) {
            Ok(job) => job,
            Err(response) => return response,
        };
        wait_for_job_progress(&job, request);
        snapshot_job_output(&job, request)
    }

    /// 终止单个后台任务：回执式——立即返回 killed 回执，不等进程退出。
    /// 退出确认由监控线程收敛（10ms 轮询 try_wait），模型随后用 job_output 轮询。
    /// 已结束的任务幂等返回 killed=false + 已记录退出码，让模型能区分
    /// 「我杀了它」和「它本来结束了」；被杀任务复用 exited，不设第三态。
    pub fn kill(&mut self, request: &JobKillRequest) -> Value {
        let id = Some(request.id);
        let job = match self.resolve_job(id, &request.job_id) {
            Ok(job) => job,
            Err(response) => return response,
        };
        let state = *job.state.lock().expect("任务状态锁不应中毒");
        if let JobState::Exited { exit_code, .. } = state {
            return json!({
                "id": request.id, "ok": true,
                "job_id": request.job_id,
                "killed": false,
                "status": "exited",
                "exit_code": exit_code,
            });
        }
        job.terminate_tree();
        json!({
            "id": request.id, "ok": true,
            "job_id": request.job_id,
            "killed": true,
            "status": "running",
            "exit_code": null,
        })
    }

    /// 服务退出清理：终止所有还在跑的后台任务，不留孤儿进程。
    /// Windows 下即便这一步没跑到（执行器被硬杀），job 句柄随进程关闭也会杀树。
    pub fn kill_all_running(&mut self) {
        let running: Vec<Arc<Job>> = self
            .jobs
            .values()
            .filter(|job| matches!(*job.state.lock().expect("任务状态锁不应中毒"), JobState::Running))
            .cloned()
            .collect();
        for job in running {
            job.terminate_tree();
        }
    }

    /// 解析 job_id 并取出任务：output 与 kill 共用，保证错误形状完全一致。
    /// 格式错误与「不存在」是两类错误，分别照旧给出原来的文案。
    fn resolve_job(&mut self, id: Option<u64>, raw: &str) -> Result<Arc<Job>, Value> {
        let Some(job_id) = parse_job_id(raw) else {
            return Err(crate::error_response(
                id,
                format!("job_id 格式有误: {raw}（应为 job_start 返回的 job-N）"),
            ));
        };
        self.reconcile_finished();
        match self.jobs.get(&job_id) {
            Some(job) => Ok(Arc::clone(job)),
            None => Err(crate::error_response(
                id,
                format!(
                    "job 不存在: {raw}（id 由 job_start 返回；服务重启后旧 id 一律失效，完成任务过多时最早的记录也会被清理）"
                ),
            )),
        }
    }

    /// 把已退出的任务登记进 finished 队列，并淘汰超出上限的最早记录，
    /// 释放句柄与缓冲，长时间运行不累积内存。
    /// 按 id 数序（即启动顺序）入队，保证淘汰的确实是最早的任务。
    fn reconcile_finished(&mut self) {
        for job_id in 1..=self.next_id {
            if self.finished.iter().any(|&seen| seen == job_id) {
                continue;
            }
            if let Some(job) = self.jobs.get(&job_id)
                && matches!(*job.state.lock().expect("任务状态锁不应中毒"), JobState::Exited { .. })
            {
                self.finished.push_back(job_id);
            }
        }
        while self.finished.len() > MAX_FINISHED_JOBS {
            let Some(oldest) = self.finished.pop_front() else {
                break;
            };
            self.jobs.remove(&oldest);
        }
    }
}

impl Default for JobRegistry {
    fn default() -> Self {
        Self::new()
    }
}

/// 进程级唯一注册表：主循环串行处理请求，job op 全走这一把锁。
static JOB_REGISTRY: OnceLock<Mutex<JobRegistry>> = OnceLock::new();

pub fn registry() -> &'static Mutex<JobRegistry> {
    JOB_REGISTRY.get_or_init(|| Mutex::new(JobRegistry::new()))
}

/// 并发安全的 job_output 入口：仅在查找任务时短暂持有注册表锁，等待阶段释放锁，
/// 避免带 `wait_ms` 的查询阻塞 `job_start` / `job_kill` / 无等待 `job_output`。
pub fn handle_output(request: &JobOutputRequest) -> Value {
    let job = {
        let mut reg = registry().lock().expect("任务注册表锁不应中毒");
        match reg.resolve_job(Some(request.id), &request.job_id) {
            Ok(job) => job,
            Err(response) => return response,
        }
    };
    wait_for_job_progress(&job, request);
    snapshot_job_output(&job, request)
}

/// 当 `wait_ms > 0` 且任务仍在运行时短等待：
/// - 默认（`wait_for_exit = false`）：请求偏移处已有新字节立刻返回；否则等待新输出（约 200ms 合并防抖）或退出；
/// - `wait_for_exit = true`：忽略中途零碎输出，一直等到任务退出、stdin 关闭或 `wait_ms` 到期再返回。
fn wait_for_job_progress(job: &Job, request: &JobOutputRequest) {
    let wait_ms = request.wait_ms.unwrap_or(0).min(MAX_JOB_WAIT_MS);
    if wait_ms == 0 {
        return;
    }
    let requested_offset = request.offset.unwrap_or(0) as usize;
    // 非 wait_for_exit 模式下，请求偏移处已有可读新字节时立刻返回，不进入防抖或等待循环
    if !request.wait_for_exit
        && job.buffer.lock().expect("输出缓冲锁不应中毒").total_bytes() > requested_offset
    {
        return;
    }
    let deadline = Instant::now() + Duration::from_millis(wait_ms);
    let mut debounce_until: Option<Instant> = None;

    loop {
        if crate::STDIN_CLOSED.load(std::sync::atomic::Ordering::Acquire) {
            break;
        }
        let exited = {
            let state = job.state.lock().expect("任务状态锁不应中毒");
            matches!(*state, JobState::Exited { .. })
        };
        if exited {
            break;
        }
        let now = Instant::now();
        if !request.wait_for_exit {
            let total_bytes = job.buffer.lock().expect("输出缓冲锁不应中毒").total_bytes();
            if total_bytes > requested_offset {
                let until = *debounce_until.get_or_insert_with(|| {
                    (now + Duration::from_millis(WAIT_DEBOUNCE_MS)).min(deadline)
                });
                if now >= until {
                    break;
                }
            }
        }
        if now >= deadline {
            break;
        }
        let target = debounce_until.map_or(deadline, |u| u.min(deadline));
        let remain = target.saturating_duration_since(now);
        thread::sleep(remain.min(Duration::from_millis(WAIT_POLL_MS)));
    }
}

fn snapshot_job_output(job: &Job, request: &JobOutputRequest) -> Value {
    // 先读任务状态再拍输出快照：若已 Exited 则缓冲已最终落定，末尾残缺 UTF-8 序列不再挂起等待
    let (is_running, status, exit_code, elapsed_ms) = {
        let state = job.state.lock().expect("任务状态锁不应中毒");
        match *state {
            JobState::Running => (
                true,
                "running",
                None,
                job.started_at.elapsed().as_millis() as u64,
            ),
            JobState::Exited { exit_code, elapsed_ms } => (false, "exited", Some(exit_code), elapsed_ms),
        }
    };

    // 快照缓冲：head 在前 tail 在后（omitted>0 时中间隔着丢弃段），拷贝一次
    // 便于按原始字节坐标切片；上限 = max_output_bytes，快照本身不超缓冲上限
    let max_bytes = request.max_output_bytes.max(1) as usize;
    let total;
    let head_len;
    let tail_start;
    let omitted;
    let snapshot;
    {
        let mut buffer = job.buffer.lock().expect("输出缓冲锁不应中毒");
        total = buffer.total_bytes();
        head_len = buffer.head_bytes().len();
        let tail_len = buffer.tail_bytes().len();
        tail_start = total - tail_len;
        omitted = buffer.omitted_bytes();
        snapshot = buffer.to_bytes();
    }

    let offset = request.offset.unwrap_or(0).min(total as u64) as usize;
    let output;
    let next_offset;
    if omitted > 0 && offset >= head_len && offset < tail_start {
        // 请求落在已丢弃的中间段：标注省略量并跳到尾部起点
        output = format_output_omission_marker(tail_start - offset);
        next_offset = tail_start as u64;
    } else {
        // 原始字节坐标 → 快照内下标：头部一一对应；尾部整体前移
        //（omitted==0 时 tail_start == head_len，公式退化为恒等映射）
        let snapshot_start = if offset >= tail_start {
            head_len + (offset - tail_start)
        } else {
            offset
        };
        let raw_end = if omitted > 0 && offset < head_len {
            // 头部之外隔着丢弃段，最多读到丢弃段前
            offset.saturating_add(max_bytes).min(head_len)
        } else {
            offset.saturating_add(max_bytes).min(total)
        };
        let snapshot_end = if raw_end > tail_start {
            head_len + (raw_end - tail_start)
        } else {
            raw_end
        };
        let chunk = &snapshot[snapshot_start..snapshot_end];
        // 开头对齐：尾部滚动切点跳过孤立续字节；调用方手传半字符 offset 时跳到该合法字符末尾；
        // 真正的非 UTF-8 字节（如 0x80/GBK）不跳过，交给 decode_lossy_stream 转成 U+FFFD 并计入消费量
        let skip = if omitted > 0 && offset == tail_start {
            chunk.len() - aligned_tail(chunk).len()
        } else {
            utf8_straddle_skip(&snapshot[..snapshot_end], snapshot_start)
        };
        let aligned_start = snapshot_start + skip;
        let aligned = &snapshot[aligned_start..snapshot_end];
        let stream_limit = if omitted > 0 && offset < head_len {
            head_len
        } else {
            snapshot.len()
        };
        let (mut decoded, mut consumed) = decode_lossy_stream(aligned, true);
        if consumed < aligned.len() {
            let tail_lead = aligned_start + consumed;
            let lookahead_end = stream_limit.min(tail_lead + 4);
            let next_valid_char = if snapshot_end < stream_limit {
                match std::str::from_utf8(&snapshot[tail_lead..lookahead_end]) {
                    Ok(s) => s.chars().next(),
                    Err(err) if err.valid_up_to() > 0 => {
                        std::str::from_utf8(&snapshot[tail_lead..tail_lead + err.valid_up_to()])
                            .ok()
                            .and_then(|s| s.chars().next())
                    }
                    Err(_) => None,
                }
            } else {
                None
            };

            if let Some(ch) = next_valid_char {
                // 快照内已存在完整合法的多字节字符：若 skip+consumed 已能推进偏移则留给下次读；
                // 若 max_output_bytes 小于单字符字节数（1~3），直接补齐该完整字符推进偏移，绝不打碎成 U+FFFD
                if skip + consumed == 0 {
                    decoded.push(ch);
                    consumed = ch.len_utf8();
                }
            } else if !(is_running && raw_end == total) {
                // 非运行期实时末尾，且后续字节证明并非被切开的合法字符：按 lossy 消费到底防卡死
                let (lossy_text, lossy_consumed) = decode_lossy_stream(aligned, false);
                decoded = lossy_text;
                consumed = lossy_consumed;
            }
        }
        output = decoded;
        next_offset = (offset + skip + consumed) as u64;
    }
    json!({
        "id": request.id, "ok": true,
        "job_id": request.job_id,
        "status": status,
        "exit_code": exit_code,
        "elapsed_ms": elapsed_ms,
        "output": output,
        "next_offset": next_offset,
        "total_bytes": total,
        "omitted_bytes": omitted,
    })
}

/// job_id 解析：接受 job_start 返回的 job-N，也容忍纯数字。
fn parse_job_id(raw: &str) -> Option<u64> {
    let text = raw.trim();
    let text = text.strip_prefix("job-").unwrap_or(text);
    text.parse::<u64>().ok()
}

/// 任务监控线程：轮询子进程退出 → 宽限内等输出泵收尾 → 标记最终状态。
fn monitor(job: Arc<Job>) {
    let exit_code = loop {
        thread::sleep(Duration::from_millis(crate::POLL_INTERVAL_MS));
        let Ok(mut child) = job.child.lock() else {
            // 锁中毒说明注册表侧已经放弃这个任务，监控线程直接退出
            return;
        };
        match child.try_wait() {
            Ok(Some(status)) => break status.code().unwrap_or(-1),
            Ok(None) => {}
            Err(_) => break -1,
        }
    };

    // 输出泵在子进程退出后很快收到 EOF 并发完成信号；宽限内收不到（泄漏的
    // 孙进程握着管道写端）就放弃等待，信号通道随 receiver 一起丢弃
    let done: Vec<mpsc::Receiver<()>> = job
        .reader_done
        .lock()
        .map(|mut guard| guard.drain(..).collect())
        .unwrap_or_default();
    let deadline = Instant::now() + Duration::from_millis(READER_GRACE_MS);
    for receiver in done {
        let remain = deadline.saturating_duration_since(Instant::now());
        if remain.is_zero() {
            break;
        }
        if receiver.recv_timeout(remain).is_err() {
            break;
        }
    }

    let elapsed_ms = job.started_at.elapsed().as_millis() as u64;
    if let Ok(mut state) = job.state.lock() {
        *state = JobState::Exited { exit_code, elapsed_ms };
    }
}

#[cfg(test)]
#[path = "jobs_tests.rs"]
pub(crate) mod tests;
