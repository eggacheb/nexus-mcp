//! 托盘内受控热切换与 10 秒 /health 失败自动回滚。
//!
//! 托盘宿主在 127.0.0.1:0 监听极薄的本地控制入口，并把端口与随机 token 写入
//! 运行目录的 `.tray-control.json`（退出时清理）。支持：
//! - POST /hotswap：校验新产物存在后立即返回 202，延迟 1–2 秒停旧核（保隧道）、
//!   备份 `.prev`、替换并拉起新版、10 秒内探测 /health 200；失败自动还原 `.prev`。
//! - POST /quit：受控优雅退出托盘（供外部切换器更新托盘自身时保隧道退出）。

use std::fs::{self, OpenOptions};
use std::io::{self, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::http_client;
use crate::server_proc::{ManagedServer, ServerLaunchSpec};

pub const CONTROL_FILE_NAME: &str = ".tray-control.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ControlEndpointInfo {
    pub port: u16,
    pub pid: u32,
    pub token: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HotswapRequest {
    server_path: String,
    #[serde(default)]
    executor_path: Option<String>,
    #[serde(default)]
    delay_ms: Option<u64>,
    #[serde(default)]
    health_timeout_ms: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct QuitRequest {
    #[serde(default = "default_true")]
    include_tunnel: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SpawnWorkerRequest {
    program: String,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default)]
    cwd: Option<String>,
}

fn default_true() -> bool {
    true
}

fn generate_token() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let pid = std::process::id() as u128;
    format!("{:032x}", nanos ^ (pid.wrapping_mul(0x9E37_79B9_7F4A_7C15)))
}

fn append_log(log_path: &Path, line: &str) {
    if let Some(parent) = log_path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(log_path) {
        let _ = writeln!(file, "[{ts}] {line}");
    }
}

#[derive(Serialize)]
struct LastHotswapRecord<'a> {
    status: &'a str,
    mode: &'a str,
    at: String,
    detail: &'a str,
}

fn write_last_hotswap(log_path: &Path, status: &str, detail: &str) {
    let Some(parent) = log_path.parent() else {
        return;
    };
    let _ = fs::create_dir_all(parent);
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let record = LastHotswapRecord {
        status,
        mode: "in-place",
        at: ts.to_string(),
        detail,
    };
    if let Ok(json) = serde_json::to_string_pretty(&record) {
        let _ = fs::write(parent.join("last-hotswap.json"), json);
    }
}

fn backup_file(target: &Path) -> io::Result<Option<PathBuf>> {
    if !target.exists() {
        return Ok(None);
    }
    let mut prev = target.as_os_str().to_os_string();
    prev.push(".prev");
    let prev_path = PathBuf::from(prev);
    fs::copy(target, &prev_path)?;
    Ok(Some(prev_path))
}

fn restore_file(prev: &Path, target: &Path) -> io::Result<()> {
    if prev.exists() {
        fs::copy(prev, target)?;
    }
    Ok(())
}

/// 拷贝覆盖目标文件，Windows 下旧进程刚退出可能短暂占句柄，做有界重试。
fn copy_with_retry(src: &Path, dst: &Path) -> io::Result<()> {
    let mut last_err = None;
    for _ in 0..20 {
        match fs::copy(src, dst) {
            Ok(_) => return Ok(()),
            Err(err) => {
                last_err = Some(err);
                thread::sleep(Duration::from_millis(100));
            }
        }
    }
    Err(last_err.unwrap_or_else(|| io::Error::other("复制文件失败")))
}

fn wait_for_health(child: &mut ManagedServer, mcp_port: u16, timeout: Duration) -> Result<(), String> {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if !child.is_running() {
            return Err("新协议层进程提前退出，未通过 /health 校验".to_string());
        }
        if let Ok(resp) = http_client::get(mcp_port, "/health", Duration::from_millis(500))
            && resp.status == 200
        {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(150));
    }
    Err(format!(
        "新协议层在 {}ms 内未通过 127.0.0.1:{mcp_port}/health 校验",
        timeout.as_millis()
    ))
}

/// 执行托盘内无缝换核（停旧核保隧道 -> 备份 .prev -> 替换 -> 拉新 -> /health 校验 -> 失败回滚）。
pub fn perform_hotswap(
    server_slot: &Arc<Mutex<Option<ManagedServer>>>,
    spec: &ServerLaunchSpec,
    runtime_dir: &Path,
    new_server_src: &Path,
    new_executor_src: Option<&Path>,
    shutdown_timeout: Duration,
    health_timeout: Duration,
    log_path: &Path,
) -> Result<(), String> {
    append_log(
        log_path,
        &format!(
            "hotswap.start server={} executor={}",
            new_server_src.display(),
            new_executor_src
                .map(|p| p.display().to_string())
                .unwrap_or_else(|| "-".to_string())
        ),
    );

    // 决定被替换的目标路径：优先替换为 spec.args 中的首个脚本（测试 stub 模式），否则替换 spec.program
    let target_server = if spec.program.file_name().and_then(|n| n.to_str()) == Some("node")
        && !spec.args.is_empty()
    {
        PathBuf::from(&spec.args[0])
    } else {
        spec.program.clone()
    };
    let target_executor = runtime_dir.join("nexus-executor.exe");

    let mut guard = server_slot
        .lock()
        .map_err(|_| "获取协议层进程锁失败".to_string())?;

    // 1) 优雅停止旧协议层，保持隧道不断 (include_tunnel = false)
    if let Some(mut old) = guard.take() {
        let graceful = old.shutdown(false, shutdown_timeout);
        append_log(
            log_path,
            &format!("hotswap.old_stopped graceful={graceful} include_tunnel=false"),
        );
    }

    // 2) 备份旧文件为 .prev（绝不触碰 config.json 与 oauth-store.json）
    let restore_and_record = |guard: &mut Option<ManagedServer>,
                              prev_server: &Option<PathBuf>,
                              prev_executor: &Option<PathBuf>,
                              reason: &str| {
        if let Some(p) = prev_server {
            let _ = restore_file(p, &target_server);
        }
        if let Some(p) = prev_executor {
            let _ = restore_file(p, &target_executor);
        }
        let recovered = ManagedServer::spawn(spec).ok();
        let status = if recovered.is_some() { "rolled_back" } else { "failed" };
        if let Some(restored) = recovered {
            *guard = Some(restored);
        }
        write_last_hotswap(log_path, status, reason);
    };

    let prev_server = match backup_file(&target_server) {
        Ok(p) => p,
        Err(e) => {
            let reason = format!("备份旧协议层失败: {e}");
            write_last_hotswap(log_path, "failed", &reason);
            return Err(reason);
        }
    };
    let prev_executor = if new_executor_src.is_some() {
        match backup_file(&target_executor) {
            Ok(p) => p,
            Err(e) => {
                let reason = format!("备份旧执行器失败: {e}");
                write_last_hotswap(log_path, "failed", &reason);
                return Err(reason);
            }
        }
    } else {
        None
    };

    // 3) 写入新产物
    let replace_result: io::Result<()> = (|| {
        copy_with_retry(new_server_src, &target_server)?;
        if let Some(exec_src) = new_executor_src {
            copy_with_retry(exec_src, &target_executor)?;
        }
        Ok(())
    })();

    if let Err(err) = replace_result {
        append_log(log_path, &format!("hotswap.copy_failed err={err}，开始回滚"));
        let reason = format!("替换产物失败并已回滚: {err}");
        restore_and_record(&mut guard, &prev_server, &prev_executor, &reason);
        return Err(reason);
    }

    // 4) 拉起新协议层并执行 10 秒 /health 校验
    let mut new_child = match ManagedServer::spawn(spec) {
        Ok(c) => c,
        Err(err) => {
            let reason = format!("拉起新协议层失败: {err}");
            append_log(log_path, &format!("hotswap.spawn_failed {reason}，开始回滚"));
            restore_and_record(&mut guard, &prev_server, &prev_executor, &reason);
            return Err(reason);
        }
    };

    match wait_for_health(&mut new_child, spec.mcp_port, health_timeout) {
        Ok(()) => {
            let detail = format!("pid={} port={}", new_child.pid(), spec.mcp_port);
            append_log(log_path, &format!("hotswap.success {detail}"));
            write_last_hotswap(log_path, "ok", &detail);
            *guard = Some(new_child);
            Ok(())
        }
        Err(reason) => {
            append_log(
                log_path,
                &format!("hotswap.health_failed reason={reason}，开始自动回滚"),
            );
            let _ = new_child.shutdown(false, Duration::from_secs(2));
            if let Some(p) = &prev_server {
                let _ = restore_file(p, &target_server);
            }
            if let Some(p) = &prev_executor {
                let _ = restore_file(p, &target_executor);
            }
            match ManagedServer::spawn(spec) {
                Ok(mut restored) => {
                    let recovered = wait_for_health(&mut restored, spec.mcp_port, health_timeout);
                    append_log(
                        log_path,
                        &format!(
                            "hotswap.rollback_done pid={} recovered={}",
                            restored.pid(),
                            recovered.is_ok()
                        ),
                    );
                    write_last_hotswap(
                        log_path,
                        if recovered.is_ok() { "rolled_back" } else { "failed" },
                        &reason,
                    );
                    *guard = Some(restored);
                }
                Err(err) => {
                    append_log(log_path, &format!("hotswap.rollback_spawn_failed err={err}"));
                    write_last_hotswap(log_path, "failed", &format!("{reason}; 回滚启动失败: {err}"));
                }
            }
            Err(reason)
        }
    }
}

pub struct ControlServerHandle {
    stop: Arc<AtomicBool>,
    control_file: PathBuf,
    pub info: ControlEndpointInfo,
}

impl Drop for ControlServerHandle {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        let _ = fs::remove_file(&self.control_file);
    }
}

fn write_http(mut stream: TcpStream, status: u16, reason: &str, body: &str) {
    let resp = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(resp.as_bytes());
    let _ = stream.flush();
}

fn parse_request(stream: &mut TcpStream) -> Option<(String, String, Option<String>, String)> {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    let mut buf = Vec::new();
    let mut chunk = [0u8; 4096];
    let mut header_end = None;
    let mut content_len = 0usize;

    loop {
        match stream.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => {
                buf.extend_from_slice(&chunk[..n]);
                if header_end.is_none()
                    && let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n")
                {
                    header_end = Some(pos + 4);
                    let head = String::from_utf8_lossy(&buf[..pos]);
                    for line in head.lines().skip(1) {
                        if let Some((k, v)) = line.split_once(':')
                            && k.trim().eq_ignore_ascii_case("content-length")
                        {
                            content_len = v.trim().parse().unwrap_or(0);
                        }
                    }
                }
                if let Some(end) = header_end
                    && buf.len() >= end + content_len
                {
                    break;
                }
                if buf.len() > 128 * 1024 {
                    return None;
                }
            }
            Err(_) => break,
        }
    }

    let end = header_end?;
    let head = String::from_utf8_lossy(&buf[..end - 4]);
    let mut lines = head.lines();
    let req_line = lines.next()?;
    let mut parts = req_line.split_whitespace();
    let method = parts.next()?.to_string();
    let path = parts.next()?.to_string();
    let mut token = None;
    for line in lines {
        if let Some((k, v)) = line.split_once(':')
            && k.trim().eq_ignore_ascii_case("x-tray-token")
        {
            token = Some(v.trim().to_string());
        }
    }
    let body_end = (end + content_len).min(buf.len());
    let body = String::from_utf8_lossy(&buf[end..body_end]).to_string();
    Some((method, path, token, body))
}

pub fn start_control_server(
    runtime_dir: PathBuf,
    log_dir: PathBuf,
    spec: ServerLaunchSpec,
    server_slot: Arc<Mutex<Option<ManagedServer>>>,
    shutdown_timeout: Duration,
    on_quit: Arc<dyn Fn(bool) + Send + Sync>,
) -> io::Result<ControlServerHandle> {
    let listener = TcpListener::bind("127.0.0.1:0")?;
    listener.set_nonblocking(true)?;
    let port = listener.local_addr()?.port();
    let token = generate_token();
    let info = ControlEndpointInfo {
        port,
        pid: std::process::id(),
        token: token.clone(),
    };

    let control_file = runtime_dir.join(CONTROL_FILE_NAME);
    if let Ok(json) = serde_json::to_string_pretty(&info) {
        let _ = fs::write(&control_file, format!("{json}\n"));
    }

    let stop = Arc::new(AtomicBool::new(false));
    let stop_flag = Arc::clone(&stop);
    let busy = Arc::new(AtomicBool::new(false));
    let log_path = log_dir.join("hotswap.log");

    thread::spawn(move || {
        while !stop_flag.load(Ordering::Relaxed) {
            match listener.accept() {
                Ok((mut stream, _addr)) => {
                    let Some((method, path, req_token, body)) = parse_request(&mut stream) else {
                        write_http(stream, 400, "Bad Request", r#"{"error":"invalid request"}"#);
                        continue;
                    };
                    if req_token.as_deref() != Some(token.as_str()) {
                        write_http(stream, 403, "Forbidden", r#"{"error":"invalid token"}"#);
                        continue;
                    }
                    if method == "POST" && path == "/hotswap" {
                        let Ok(req) = serde_json::from_str::<HotswapRequest>(&body) else {
                            write_http(stream, 400, "Bad Request", r#"{"error":"invalid json"}"#);
                            continue;
                        };
                        let new_server = PathBuf::from(&req.server_path);
                        let new_exec = req.executor_path.as_deref().map(PathBuf::from);
                        if !new_server.exists() {
                            write_http(
                                stream,
                                400,
                                "Bad Request",
                                r#"{"error":"serverPath not found"}"#,
                            );
                            continue;
                        }
                        if let Some(ex) = &new_exec
                            && !ex.exists()
                        {
                            write_http(
                                stream,
                                400,
                                "Bad Request",
                                r#"{"error":"executorPath not found"}"#,
                            );
                            continue;
                        }
                        if busy.swap(true, Ordering::SeqCst) {
                            write_http(
                                stream,
                                409,
                                "Conflict",
                                r#"{"error":"hotswap already in progress"}"#,
                            );
                            continue;
                        }

                        let delay = Duration::from_millis(req.delay_ms.unwrap_or(1500));
                        let health_timeout =
                            Duration::from_millis(req.health_timeout_ms.unwrap_or(10_000));
                        let resp_body = serde_json::json!({
                            "ok": true,
                            "queued": true,
                            "delayMs": delay.as_millis() as u64,
                            "logPath": log_path.to_string_lossy(),
                        })
                        .to_string();
                        write_http(stream, 202, "Accepted", &resp_body);

                        let slot = Arc::clone(&server_slot);
                        let spec_c = spec.clone();
                        let dir_c = runtime_dir.clone();
                        let log_c = log_path.clone();
                        let busy_c = Arc::clone(&busy);
                        thread::spawn(move || {
                            thread::sleep(delay);
                            let _ = perform_hotswap(
                                &slot,
                                &spec_c,
                                &dir_c,
                                &new_server,
                                new_exec.as_deref(),
                                shutdown_timeout,
                                health_timeout,
                                &log_c,
                            );
                            busy_c.store(false, Ordering::SeqCst);
                        });
                    } else if method == "POST" && path == "/spawn-worker" {
                        let Ok(req) = serde_json::from_str::<SpawnWorkerRequest>(&body) else {
                            write_http(stream, 400, "Bad Request", r#"{"error":"invalid json"}"#);
                            continue;
                        };
                        let prog = PathBuf::from(&req.program);
                        if !prog.exists() {
                            write_http(stream, 400, "Bad Request", r#"{"error":"program not found"}"#);
                            continue;
                        }
                        let mut cmd = Command::new(&prog);
                        cmd.args(&req.args)
                            .stdin(Stdio::null())
                            .stdout(Stdio::null())
                            .stderr(Stdio::null());
                        if let Some(cwd) = &req.cwd
                            && !cwd.trim().is_empty()
                        {
                            cmd.current_dir(cwd.trim());
                        }
                        #[cfg(windows)]
                        {
                            use std::os::windows::process::CommandExt;
                            // DETACHED_PROCESS | CREATE_NO_WINDOW：由不在 nexus-executor Job 内的托盘宿主拉起，彻底避免被连带树杀
                            const DETACHED_PROCESS: u32 = 0x0000_0008;
                            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
                            cmd.creation_flags(DETACHED_PROCESS | CREATE_NO_WINDOW);
                        }
                        match cmd.spawn() {
                            Ok(child) => {
                                let resp_body = serde_json::json!({
                                    "ok": true,
                                    "pid": child.id(),
                                })
                                .to_string();
                                write_http(stream, 202, "Accepted", &resp_body);
                            }
                            Err(err) => {
                                let resp_body = serde_json::json!({
                                    "error": format!("spawn worker failed: {err}"),
                                })
                                .to_string();
                                write_http(stream, 500, "Internal Server Error", &resp_body);
                            }
                        }
                    } else if method == "POST" && path == "/quit" {
                        let req = serde_json::from_str::<QuitRequest>(&body)
                            .unwrap_or(QuitRequest { include_tunnel: true });
                        write_http(
                            stream,
                            200,
                            "OK",
                            &format!(r#"{{"ok":true,"includeTunnel":{}}}"#, req.include_tunnel),
                        );
                        let quit_cb = Arc::clone(&on_quit);
                        let inc = req.include_tunnel;
                        thread::spawn(move || {
                            thread::sleep(Duration::from_millis(80));
                            quit_cb(inc);
                        });
                    } else {
                        write_http(stream, 404, "Not Found", r#"{"error":"not found"}"#);
                    }
                }
                Err(err) if err.kind() == io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(50));
                }
                Err(_) => break,
            }
        }
    });

    Ok(ControlServerHandle {
        stop,
        control_file,
        info,
    })
}
