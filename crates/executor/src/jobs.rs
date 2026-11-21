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
use crate::string::{aligned_tail, truncated_prefix};

/// job 输出缓冲与单次读取的缺省字节上限，与配置 maxOutputBytes 默认一致
const DEFAULT_JOB_MAX_OUTPUT_BYTES: u64 = 64 * 1024;
/// 完成任务记录的保留上限；超出时从最早的开始淘汰，防止长时间运行累积内存
const MAX_FINISHED_JOBS: usize = 50;
/// 子进程退出后等输出泵收尾的宽限；等不到就不再等（泄漏的孙进程握着管道时
/// 不能一直卡住退出状态），残留输出会在记录淘汰或服务退出时随管道关闭补齐
const READER_GRACE_MS: u64 = 500;

fn default_job_max_output_bytes() -> u64 {
    DEFAULT_JOB_MAX_OUTPUT_BYTES
}

/// policy 是命令闸门配置（config.json 的 commandPolicy），缺省时仅内置危险表生效。
#[derive(Deserialize)]
pub struct JobStartRequest {
    pub id: u64,
    pub command: String,
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
    Exited { exit_code: i32 },
}

/// 任务记录。Arc 共享：注册表管生死，监控线程写状态，output() 读缓冲。
struct Job {
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
        let command = match crate::build_shell_command(
            &request.shell.kind,
            &request.shell.program,
            &request.command,
            &request.cwd,
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

    /// 读取任务输出：按字节偏移增量返回，重复推进不重复给同一段内容；
    /// 请求落在已丢弃的中间段时给出省略标注并跳到尾部起点。
    pub fn output(&mut self, request: &JobOutputRequest) -> Value {
        let id = Some(request.id);
        let job = match self.resolve_job(id, &request.job_id) {
            Ok(job) => job,
            Err(response) => return response,
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
            // UTF-8 边界对齐：开头跳过不完整的续字节（模型乱传 offset 时），
            // 结尾丢掉不完整的序列（多字节字符被泵的读边界切开时），这些字节
            // 留在缓冲里，下次从同一偏移补读，内容不会重复也不会丢
            let aligned = aligned_tail(chunk);
            let skip = chunk.len() - aligned.len();
            output = truncated_prefix(aligned, aligned.len());
            next_offset = (offset + skip + output.len()) as u64;
        }

        let (status, exit_code) = {
            let state = job.state.lock().expect("任务状态锁不应中毒");
            match *state {
                JobState::Running => ("running", None),
                JobState::Exited { exit_code } => ("exited", Some(exit_code)),
            }
        };
        json!({
            "id": request.id, "ok": true,
            "job_id": request.job_id,
            "status": status,
            "exit_code": exit_code,
            "output": output,
            "next_offset": next_offset,
            "total_bytes": total,
            "omitted_bytes": omitted,
        })
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
        if let JobState::Exited { exit_code } = state {
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

    if let Ok(mut state) = job.state.lock() {
        *state = JobState::Exited { exit_code };
    }
}

#[cfg(test)]
#[path = "jobs_tests.rs"]
mod tests;
