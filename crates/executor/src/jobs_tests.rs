//! job_start / job_output / job_kill 注册表级测试。每个测试用独立 JobRegistry，
//! 与全局注册表（handle_request 路径）互不干扰；需要 Git Bash。

use crate::jobs::{JobKillRequest, JobOutputRequest, JobRegistry, JobStartRequest};
use crate::ShellSpec;
use serde_json::Value;
use std::path::Path;
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

/// 真实 spawn bash 的测试（jobs_tests 与 main_tests）共享本锁串行执行，
/// 避免 cargo 默认并行跑测试把 Windows 进程创建压满、拖垮时序断言。
static SPAWN_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

pub(crate) fn spawn_lock() -> std::sync::MutexGuard<'static, ()> {
    SPAWN_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn git_bash() -> String {
    let path = std::env::var("NEXUS_GIT_BASH")
        .unwrap_or_else(|_| r"C:\Program Files\Git\bin\bash.exe".into());
    assert!(
        Path::new(&path).exists(),
        "本测试需要 Git Bash（或设置 NEXUS_GIT_BASH）"
    );
    path
}

fn start_request(command: &str, max_output_bytes: u64) -> JobStartRequest {
    JobStartRequest {
        id: 1,
        command: command.into(),
        root: env!("CARGO_MANIFEST_DIR").into(),
        cwd: env!("CARGO_MANIFEST_DIR").into(),
        max_output_bytes,
        shell: ShellSpec {
            kind: "git-bash".into(),
            program: git_bash(),
        },
        policy: None,
    }
}

fn output_request(job_id: &str, offset: Option<u64>, max_output_bytes: u64) -> JobOutputRequest {
    JobOutputRequest {
        id: 2,
        job_id: job_id.into(),
        offset,
        max_output_bytes,
        wait_ms: None,
        wait_for_exit: false,
    }
}

fn kill_request(job_id: &str) -> JobKillRequest {
    JobKillRequest {
        id: 3,
        job_id: job_id.into(),
    }
}

/// 轮询直到任务退出，返回最后的 job_output 响应
fn wait_exited(registry: &mut JobRegistry, job_id: &str, max_bytes: u64, timeout_ms: u64) -> Value {
    let deadline = Instant::now() + Duration::from_millis(timeout_ms);
    loop {
        let response = registry.output(&output_request(job_id, None, max_bytes));
        if response["status"] == "exited" {
            return response;
        }
        assert!(
            Instant::now() < deadline,
            "任务在 {timeout_ms}ms 内没有退出: {response}"
        );
        thread::sleep(Duration::from_millis(30));
    }
}

/// 从 job_output 文本推进 next_offset 直到读完（含省略标注跳转），返回非空页文本
fn read_to_end(registry: &mut JobRegistry, job_id: &str, max_bytes: u64) -> Vec<String> {
    let mut pages = Vec::new();
    let mut offset = 0u64;
    for _ in 0..8 {
        let response = registry.output(&output_request(job_id, Some(offset), max_bytes));
        assert_eq!(response["ok"], Value::Bool(true));
        let next = response["next_offset"].as_u64().expect("next_offset");
        let text = response["output"].as_str().expect("output").to_string();
        let no_progress = next == offset;
        if !no_progress || !text.is_empty() {
            pages.push(text);
        }
        if no_progress {
            break;
        }
        offset = next;
    }
    pages
}

#[test]
fn unknown_job_id_is_a_clear_error() {
    let mut registry = JobRegistry::new();
    let response = registry.output(&output_request("job-99999", None, 4096));
    assert_eq!(response["ok"], Value::Bool(false));
    let error = response["error"].as_str().unwrap();
    assert!(error.contains("不存在"), "报错要指明不存在: {error}");
    assert!(error.contains("job-99999"), "报错要带上原始 id: {error}");
}

#[test]
fn malformed_job_id_is_a_clear_error() {
    let mut registry = JobRegistry::new();
    let response = registry.output(&output_request("not-a-job", None, 4096));
    assert_eq!(response["ok"], Value::Bool(false));
    assert!(response["error"].as_str().unwrap().contains("格式"));
}

#[test]
fn start_returns_unique_ids_without_waiting_for_command() {
    let _guard = spawn_lock();
    let mut registry = JobRegistry::new();
    let started = Instant::now();
    let first = registry.start(&start_request("echo quick-a", 4096));
    let second = registry.start(&start_request("echo quick-b", 4096));
    let elapsed = started.elapsed();
    // 严格 200ms 由 TS 层端到端断言（MCP 客户端实测 ~100ms）；这里在 cargo
    // 并行测试负载下只验证「不等命令结束」，预算放宽到 1s
    assert!(elapsed < Duration::from_millis(1_000), "两次启动共耗时 {elapsed:?}");
    assert_eq!(first["ok"], Value::Bool(true));
    assert_eq!(second["ok"], Value::Bool(true));
    let first_id = first["job_id"].as_str().unwrap();
    let second_id = second["job_id"].as_str().unwrap();
    assert_ne!(first_id, second_id, "连续启动的 id 不能冲突");
    assert!(first_id.starts_with("job-") && second_id.starts_with("job-"));
}

#[test]
fn output_reports_running_then_exit_code() {
    let _guard = spawn_lock();
    let mut registry = JobRegistry::new();
    let start = registry.start(&start_request("echo marker-final", 4096));
    let job_id = start["job_id"].as_str().unwrap().to_string();
    let response = registry.output(&output_request(&job_id, None, 4096));
    assert_eq!(response["ok"], Value::Bool(true));
    assert_eq!(response["status"], "running");
    assert_eq!(response["exit_code"], Value::Null);

    let final_response = wait_exited(&mut registry, &job_id, 4096, 10_000);
    assert_eq!(final_response["exit_code"], 0);
    assert!(final_response["output"].as_str().unwrap().contains("marker-final"));
}

#[test]
fn incremental_reads_do_not_repeat_content() {
    let _guard = spawn_lock();
    let mut registry = JobRegistry::new();
    let command = "echo chunk-1; sleep 0.5; echo chunk-2; sleep 0.5; echo chunk-3";
    let start = registry.start(&start_request(command, 4096));
    let job_id = start["job_id"].as_str().unwrap().to_string();

    // 等第一段输出出现
    let deadline = Instant::now() + Duration::from_secs(5);
    let (mut response, first_text) = loop {
        let response = registry.output(&output_request(&job_id, None, 4096));
        let text = response["output"].as_str().unwrap().to_string();
        if text.contains("chunk-1") {
            break (response, text);
        }
        assert!(Instant::now() < deadline, "第一段输出迟迟没出现");
        thread::sleep(Duration::from_millis(30));
    };
    assert!(first_text.contains("chunk-1"));
    assert!(!first_text.contains("chunk-2"));
    let mut offset = response["next_offset"].as_u64().unwrap();

    // 第二段：轮询到新输出出现，从上次偏移继续，不重复 chunk-1
    let poll_deadline = Instant::now() + Duration::from_secs(5);
    loop {
        thread::sleep(Duration::from_millis(30));
        response = registry.output(&output_request(&job_id, Some(offset), 4096));
        let second_text = response["output"].as_str().unwrap();
        if !second_text.is_empty() {
            assert!(second_text.contains("chunk-2"), "实际: {second_text}");
            assert!(!second_text.contains("chunk-1"), "增量读不能重复旧内容");
            break;
        }
        assert!(Instant::now() < poll_deadline, "第二段输出迟迟没出现");
    }
    offset = response["next_offset"].as_u64().unwrap();

    // 第三段同理
    loop {
        thread::sleep(Duration::from_millis(30));
        response = registry.output(&output_request(&job_id, Some(offset), 4096));
        let third_text = response["output"].as_str().unwrap();
        if !third_text.is_empty() {
            assert!(third_text.contains("chunk-3"), "实际: {third_text}");
            assert!(!third_text.contains("chunk-2"), "增量读不能重复旧内容");
            break;
        }
        assert!(Instant::now() < poll_deadline, "第三段输出迟迟没出现");
    }

    let final_response = wait_exited(&mut registry, &job_id, 4096, 10_000);
    assert_eq!(final_response["exit_code"], 0);
}

#[test]
fn bounded_output_keeps_head_and_tail_with_marker() {
    let _guard = spawn_lock();
    let mut registry = JobRegistry::new();
    // 约 108KB 输出，缓冲上限 4096（头尾各 2048）
    let start = registry.start(&start_request("seq 1 20000", 4096));
    let job_id = start["job_id"].as_str().unwrap().to_string();
    let final_response = wait_exited(&mut registry, &job_id, 4096, 15_000);
    assert_eq!(final_response["exit_code"], 0);
    assert!(final_response["omitted_bytes"].as_u64().unwrap() > 0);

    let pages = read_to_end(&mut registry, &job_id, 4096);
    // 第一页是头部：完整数字序列的开头，不带省略标注
    assert!(pages[0].starts_with("1\n"), "头部应从第 1 行开始");
    assert!(!pages[0].contains("bytes omitted"));
    // 中间某页给出省略标注，最后一页是尾部
    assert!(
        pages.iter().any(|page| page.contains("bytes omitted")),
        "必须有省略标注: {pages:?}"
    );
    assert!(pages.last().unwrap().contains("20000"), "尾部要保留最后输出");
}

#[test]
fn multibyte_output_stays_valid_across_read_boundaries() {
    let _guard = spawn_lock();
    let mut registry = JobRegistry::new();
    let command = "for i in $(seq 1 300); do echo \"第${i}行中文输出测试\"; done";
    let start = registry.start(&start_request(command, 1024));
    let job_id = start["job_id"].as_str().unwrap().to_string();
    wait_exited(&mut registry, &job_id, 1024, 15_000);

    let pages = read_to_end(&mut registry, &job_id, 1024);
    let merged: String = pages.concat();
    assert!(!merged.contains('\u{FFFD}'), "多字节字符不能被读边界切碎");
    assert!(merged.contains("第1行"), "头部要保留首行");
    assert!(merged.contains("第300行"), "尾部要保留末行");
    // 页与页之间不重复、不跳跃：页数多于 1（内容量超过单次上限）
    assert!(pages.len() > 1, "内容应跨多页读取");
}

#[test]
fn multibyte_output_small_window_and_straddle_offset_never_corrupt() {
    let _guard = spawn_lock();
    let mut registry = JobRegistry::new();
    let start = registry.start(&start_request("printf '中文测试'", 1024));
    let job_id = start["job_id"].as_str().unwrap().to_string();
    wait_exited(&mut registry, &job_id, 1024, 10_000);

    // 1) 调用方从半字符 offset=1 起读且 max_output_bytes=4（skip=2 后仅剩 2 字节，小于 3 字节中文字符）
    let mut offset = 1u64;
    let mut straddle_text = String::new();
    for _ in 0..8 {
        let page = registry.output(&output_request(&job_id, Some(offset), 4));
        straddle_text.push_str(page["output"].as_str().unwrap());
        let next = page["next_offset"].as_u64().unwrap();
        let total = page["total_bytes"].as_u64().unwrap();
        assert!(next > offset, "next_offset 必须严格前进: {offset} -> {next}");
        offset = next;
        if offset >= total {
            break;
        }
    }
    assert_eq!(straddle_text, "文测试");
    assert!(!straddle_text.contains('\u{FFFD}'));

    // 2) 极小单次读取预算 max_output_bytes=2（小于单个 UTF-8 汉字字节数）也能完整无损读完
    let tiny_pages = read_to_end(&mut registry, &job_id, 2);
    let tiny_merged: String = tiny_pages.concat();
    assert_eq!(tiny_merged, "中文测试");
    assert!(!tiny_merged.contains('\u{FFFD}'));
}

#[test]
fn finished_jobs_are_evicted_to_bound_memory() {
    let _guard = spawn_lock();
    let mut registry = JobRegistry::new();
    let mut ids = Vec::new();
    for index in 0..60 {
        let start = registry.start(&start_request(&format!("echo evict-{index}"), 4096));
        ids.push(start["job_id"].as_str().unwrap().to_string());
    }
    // 等最后一条退出（前面的都在启动过程中被逐个 reconcile 进 finished 队列）
    let last = ids.last().unwrap().clone();
    wait_exited(&mut registry, &last, 4096, 10_000);
    // 触发一次淘汰
    let _ = registry.output(&output_request(&last, None, 4096));
    // 最老的记录被淘汰：查不到；新记录还在
    let evicted = registry.output(&output_request(&ids[0], None, 4096));
    assert_eq!(evicted["ok"], Value::Bool(false));
    assert!(evicted["error"].as_str().unwrap().contains("不存在"));
    let kept = registry.output(&output_request(&last, None, 4096));
    assert_eq!(kept["ok"], Value::Bool(true));
    assert!(kept["output"].as_str().unwrap().contains("evict-59"));
}

#[test]
fn kill_all_running_terminates_jobs() {
    let _guard = spawn_lock();
    let mut registry = JobRegistry::new();
    let start = registry.start(&start_request("sleep 30", 4096));
    let job_id = start["job_id"].as_str().unwrap().to_string();
    let response = registry.output(&output_request(&job_id, None, 4096));
    assert_eq!(response["status"], "running");

    registry.kill_all_running();
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let response = registry.output(&output_request(&job_id, None, 4096));
        if response["status"] == "exited" {
            // taskkill /F 的退出码非 0，关键是任务死了、状态可查
            assert!(response["exit_code"].as_i64().unwrap() != 0);
            break;
        }
        assert!(Instant::now() < deadline, "kill_all 后任务没有退出");
        thread::sleep(Duration::from_millis(30));
    }
}

#[test]
fn kill_running_job_returns_receipt_then_converges_to_exited() {
    let _guard = spawn_lock();
    let mut registry = JobRegistry::new();
    let start = registry.start(&start_request("echo keep-me; sleep 30", 4096));
    assert_eq!(start["ok"], Value::Bool(true));
    let job_id = start["job_id"].as_str().unwrap().to_string();

    // 等首段输出出现：确认任务确实在跑，输出缓冲里有既有内容
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let response = registry.output(&output_request(&job_id, None, 4096));
        assert_eq!(response["status"], "running");
        if response["output"].as_str().unwrap().contains("keep-me") {
            break;
        }
        assert!(Instant::now() < deadline, "首段输出迟迟没出现");
        thread::sleep(Duration::from_millis(30));
    }

    // 回执式：立刻返回 killed=true，status 仍是 running（退出确认靠后续轮询）
    let receipt = registry.kill(&kill_request(&job_id));
    assert_eq!(receipt["ok"], Value::Bool(true));
    assert_eq!(receipt["job_id"], job_id);
    assert_eq!(receipt["killed"], Value::Bool(true));
    assert_eq!(receipt["status"], "running");
    assert_eq!(receipt["exit_code"], Value::Null);

    // 监控线程收敛：任务死亡、退出码非 0，既有输出照旧可读
    let final_response = wait_exited(&mut registry, &job_id, 4096, 10_000);
    assert!(
        final_response["exit_code"].as_i64().unwrap() != 0,
        "被杀任务应拿到非 0 退出码: {final_response}"
    );
    assert!(
        final_response["output"].as_str().unwrap().contains("keep-me"),
        "杀后既有输出不能丢: {final_response}"
    );
}

#[test]
fn kill_finished_job_returns_recorded_exit_code() {
    let _guard = spawn_lock();
    let mut registry = JobRegistry::new();
    let start = registry.start(&start_request("echo done-already", 4096));
    let job_id = start["job_id"].as_str().unwrap().to_string();
    wait_exited(&mut registry, &job_id, 4096, 10_000);

    // 幂等：不报错，killed=false + 已记录退出码，模型能区分「本来结束了」
    let receipt = registry.kill(&kill_request(&job_id));
    assert_eq!(receipt["ok"], Value::Bool(true));
    assert_eq!(receipt["killed"], Value::Bool(false));
    assert_eq!(receipt["status"], "exited");
    assert_eq!(receipt["exit_code"], 0);
}

#[test]
fn kill_unknown_job_id_is_a_clear_error() {
    let mut registry = JobRegistry::new();
    let response = registry.kill(&kill_request("job-99999"));
    assert_eq!(response["ok"], Value::Bool(false));
    let error = response["error"].as_str().unwrap();
    assert!(error.contains("不存在"), "报错要指明不存在: {error}");
    assert!(error.contains("job-99999"), "报错要带上原始 id: {error}");
    // 与 job_output 同形状：只有 id/ok/error 三个字段
    assert_eq!(response["id"], 3);
}

#[test]
fn kill_malformed_job_id_is_a_clear_error() {
    let mut registry = JobRegistry::new();
    let response = registry.kill(&kill_request("not-a-job"));
    assert_eq!(response["ok"], Value::Bool(false));
    assert!(response["error"].as_str().unwrap().contains("格式"));
}

#[test]
fn wait_ms_returns_immediately_when_output_exists_and_wakes_on_exit() {
    let _guard = spawn_lock();
    let mut registry = JobRegistry::new();
    // 1) 已有输出时传 wait_ms 也应立刻返回（不空等 200ms 防抖或 5000ms 上限）
    let start1 = registry.start(&start_request("echo ready-now; sleep 10", 4096));
    let id1 = start1["job_id"].as_str().unwrap().to_string();
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline {
        let probe = registry.output(&output_request(&id1, Some(0), 4096));
        if probe["output"].as_str().unwrap_or("").contains("ready-now") {
            break;
        }
        thread::sleep(Duration::from_millis(20));
    }
    let t0 = Instant::now();
    let immediate = registry.output(&JobOutputRequest {
        id: 10,
        job_id: id1.clone(),
        offset: Some(0),
        max_output_bytes: 4096,
        wait_ms: Some(5_000),
        wait_for_exit: false,
    });
    assert!(
        t0.elapsed() < Duration::from_millis(150),
        "已有新字节时不应进入防抖等待，实际耗时 {:?}",
        t0.elapsed()
    );
    assert!(immediate["output"].as_str().unwrap().contains("ready-now"));
    registry.kill(&kill_request(&id1));

    // 2) 尚无输出时进入等待，任务提前退出立即唤醒
    let start2 = registry.start(&start_request("sleep 0.25; echo wake-exit", 4096));
    let id2 = start2["job_id"].as_str().unwrap().to_string();
    let t1 = Instant::now();
    let woke = registry.output(&JobOutputRequest {
        id: 11,
        job_id: id2,
        offset: Some(0),
        max_output_bytes: 4096,
        wait_ms: Some(5_000),
        wait_for_exit: false,
    });
    assert_eq!(woke["status"], "exited");
    assert_eq!(woke["exit_code"], 0);
    assert!(woke["output"].as_str().unwrap().contains("wake-exit"));
    assert!(t1.elapsed() < Duration::from_secs(3));

    // 3) wait_for_exit=true 不被中途输出提前打断，等到任务退出后一次返回全量输出
    let start3 = registry.start(&start_request("echo part-1; sleep 0.5; echo part-2", 4096));
    let id3 = start3["job_id"].as_str().unwrap().to_string();
    let waited = registry.output(&JobOutputRequest {
        id: 12,
        job_id: id3,
        offset: Some(0),
        max_output_bytes: 4096,
        wait_ms: Some(5_000),
        wait_for_exit: true,
    });
    assert_eq!(waited["status"], "exited");
    assert_eq!(waited["exit_code"], 0);
    let out3 = waited["output"].as_str().unwrap();
    assert!(out3.contains("part-1") && out3.contains("part-2"));
}
