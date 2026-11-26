#![cfg_attr(not(test), windows_subsystem = "windows")]

use std::env;
use std::io::{self, BufRead};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use nexus_tray::autostart;
use nexus_tray::hotswap;
use nexus_tray::http_client;
use nexus_tray::server_proc::{ManagedServer, ServerLaunchSpec, read_ports_from_config};
use nexus_tray::single_instance::{self, AcquireResult, DEFAULT_MUTEX_NAME};
use nexus_tray::status_mapper::{LightColor, MappedStatus, map_status_json, unreachable_status};

#[cfg(windows)]
use nexus_tray::win_tray::{TrayColor, TrayCommand, TrayHandle, TrayUiState, run_tray_loop};

fn exe_dir() -> PathBuf {
    env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(Path::to_path_buf))
        .unwrap_or_else(|| env::current_dir().unwrap_or_else(|_| PathBuf::from(".")))
}

fn resolve_config_path(app_dir: &Path) -> PathBuf {
    if let Ok(override_path) = env::var("NEXUS_MCP_CONFIG") {
        let trimmed = override_path.trim();
        if !trimmed.is_empty() {
            return PathBuf::from(trimmed);
        }
    }
    app_dir.join("config.json")
}

fn resolve_log_dir(app_dir: &Path, config_path: &Path) -> PathBuf {
    if let Ok(override_dir) = env::var("NEXUS_MCP_LOG_DIR") {
        let trimmed = override_dir.trim();
        if !trimmed.is_empty() {
            return PathBuf::from(trimmed);
        }
    }
    if env::var("NEXUS_MCP_CONFIG")
        .ok()
        .map(|s| !s.trim().is_empty())
        .unwrap_or(false)
        && let Some(parent) = config_path.parent()
    {
        return parent.join("logs");
    }
    app_dir.join("logs")
}

fn open_panel_url(panel_port: u16) {
    let url = format!("http://127.0.0.1:{panel_port}");
    if let Ok(record_file) = env::var("NEXUS_TRAY_OPEN_URL_LOG") {
        let trimmed = record_file.trim();
        if !trimmed.is_empty() {
            let _ = std::fs::write(trimmed, format!("{url}\n"));
            return;
        }
    }
    if env::var("NEXUS_TRAY_NO_BROWSER").ok().as_deref() == Some("1") {
        return;
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let _ = Command::new("cmd")
            .args(["/c", "start", "", &url])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(CREATE_NO_WINDOW)
            .spawn();
    }
}

fn open_directory(dir: &Path) {
    let _ = std::fs::create_dir_all(dir);
    #[cfg(windows)]
    {
        let _ = Command::new("explorer.exe")
            .arg(dir)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn();
    }
}

fn resolve_launch_spec(app_dir: &Path) -> ServerLaunchSpec {
    let config_path = resolve_config_path(app_dir);
    let (mut mcp_port, mut panel_port) = read_ports_from_config(&config_path);
    if let Ok(p) = env::var("NEXUS_TRAY_MCP_PORT")
        && let Ok(parsed) = p.trim().parse::<u16>()
        && parsed > 0
    {
        mcp_port = parsed;
    }
    if let Ok(p) = env::var("NEXUS_TRAY_PANEL_PORT")
        && let Ok(parsed) = p.trim().parse::<u16>()
        && parsed > 0
    {
        panel_port = parsed;
    }

    let program = env::var("NEXUS_TRAY_SERVER_BIN")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| app_dir.join("nexus-server.exe"));

    let args: Vec<String> = env::var("NEXUS_TRAY_SERVER_ARGS")
        .ok()
        .and_then(|raw| serde_json::from_str::<Vec<String>>(&raw).ok())
        .unwrap_or_default();

    let working_dir = env::var("NEXUS_TRAY_WORKDIR")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| app_dir.to_path_buf());

    ServerLaunchSpec {
        program,
        args,
        working_dir,
        panel_port,
        mcp_port,
        config_path: Some(config_path),
    }
}

fn shutdown_timeout() -> Duration {
    env::var("NEXUS_TRAY_SHUTDOWN_TIMEOUT_MS")
        .ok()
        .and_then(|s| s.trim().parse::<u64>().ok())
        .filter(|&ms| ms > 0)
        .map(Duration::from_millis)
        .unwrap_or_else(|| Duration::from_secs(3))
}

#[cfg(windows)]
fn to_tray_ui_state(mapped: &MappedStatus, autostart_enabled: bool) -> TrayUiState {
    let color = match mapped.color {
        LightColor::Green => TrayColor::Green,
        LightColor::Yellow => TrayColor::Yellow,
        LightColor::Red => TrayColor::Red,
    };
    TrayUiState {
        color,
        tooltip: mapped.tooltip.clone(),
        tunnel_configured: mapped.tunnel_configured,
        tunnel_running: mapped.tunnel_running,
        autostart_enabled,
    }
}

#[cfg(windows)]
fn poll_once(panel_port: u16, mcp_port: u16) -> MappedStatus {
    // /api/status 内部包含执行器 ping 握手与 tasklist 查询，Windows 上实测可达 1.4s+，超时给足 5 秒
    match http_client::get(panel_port, "/api/status", Duration::from_secs(5)) {
        Ok(resp) if resp.status == 200 => map_status_json(&resp.body, mcp_port),
        _ => unreachable_status(mcp_port),
    }
}

fn shutdown_server_slot(server: &Arc<Mutex<Option<ManagedServer>>>, include_tunnel: bool) {
    let timeout = shutdown_timeout();
    if let Ok(mut guard) = server.lock()
        && let Some(mut child) = guard.take()
    {
        let _ = child.shutdown(include_tunnel, timeout);
    }
}

fn run_headless(
    server: Arc<Mutex<Option<ManagedServer>>>,
    quit_flag: Arc<AtomicBool>,
    quit_include_tunnel: Arc<AtomicBool>,
    watch_stdin: bool,
) {
    if watch_stdin {
        let stdin_quit = Arc::clone(&quit_flag);
        thread::spawn(move || {
            let stdin = io::stdin();
            for line in stdin.lock().lines() {
                match line {
                    Ok(text) if text.trim().eq_ignore_ascii_case("quit") => break,
                    Ok(_) => continue,
                    Err(_) => break,
                }
            }
            stdin_quit.store(true, Ordering::SeqCst);
        });
    }

    while !quit_flag.load(Ordering::SeqCst) {
        thread::sleep(Duration::from_millis(40));
    }
    let inc = quit_include_tunnel.load(Ordering::SeqCst);
    shutdown_server_slot(&server, inc);
}

fn main() {
    let app_dir = exe_dir();
    let spec = resolve_launch_spec(&app_dir);
    let runtime_dir = spec.working_dir.clone();
    let log_dir = resolve_log_dir(&runtime_dir, spec.config_path.as_deref().unwrap_or(&runtime_dir));

    let mutex_name = env::var("NEXUS_TRAY_MUTEX")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| DEFAULT_MUTEX_NAME.to_string());

    let _guard = match single_instance::acquire(&mutex_name) {
        Ok(AcquireResult::Acquired(guard)) => guard,
        Ok(AcquireResult::AlreadyRunning) => {
            open_panel_url(spec.panel_port);
            return;
        }
        Err(_) => return,
    };

    let managed = match ManagedServer::spawn(&spec) {
        Ok(s) => s,
        Err(_) => std::process::exit(1),
    };

    if let Ok(pid_file) = env::var("NEXUS_TRAY_CHILD_PID_FILE") {
        let trimmed = pid_file.trim();
        if !trimmed.is_empty() {
            let _ = std::fs::write(trimmed, format!("{}\n", managed.pid()));
        }
    }

    let server = Arc::new(Mutex::new(Some(managed)));
    let headless_quit = Arc::new(AtomicBool::new(false));
    let quit_include_tunnel = Arc::new(AtomicBool::new(true));

    #[cfg(windows)]
    let handle_slot: Arc<Mutex<Option<TrayHandle>>> = Arc::new(Mutex::new(None));
    let stop_poller = Arc::new(AtomicBool::new(false));

    let on_quit_server = Arc::clone(&server);
    let on_quit_headless = Arc::clone(&headless_quit);
    let on_quit_inc = Arc::clone(&quit_include_tunnel);
    let on_quit_poller = Arc::clone(&stop_poller);
    #[cfg(windows)]
    let on_quit_handle = Arc::clone(&handle_slot);

    let on_quit: Arc<dyn Fn(bool) + Send + Sync> = Arc::new(move |include_tunnel| {
        on_quit_inc.store(include_tunnel, Ordering::SeqCst);
        on_quit_poller.store(true, Ordering::Relaxed);
        shutdown_server_slot(&on_quit_server, include_tunnel);
        on_quit_headless.store(true, Ordering::SeqCst);
        #[cfg(windows)]
        if let Ok(guard) = on_quit_handle.lock()
            && let Some(h) = *guard
        {
            h.quit();
        }
    });

    let _control_guard = hotswap::start_control_server(
        runtime_dir.clone(),
        log_dir.clone(),
        spec.clone(),
        Arc::clone(&server),
        shutdown_timeout(),
        Arc::clone(&on_quit),
    )
    .ok();

    let headless_mode = env::var("NEXUS_TRAY_HEADLESS").ok();
    if matches!(headless_mode.as_deref(), Some("1") | Some("detached")) {
        let watch_stdin = headless_mode.as_deref() == Some("1");
        run_headless(server, headless_quit, quit_include_tunnel, watch_stdin);
        return;
    }

    #[cfg(windows)]
    {
        let panel_port = spec.panel_port;
        let mcp_port = spec.mcp_port;
        let self_exe = env::current_exe().unwrap_or_else(|_| app_dir.join("nexus-mcp.exe"));
        let initial_autostart = autostart::startup_dir()
            .map(|d| autostart::is_enabled_in(&d))
            .unwrap_or(false);

        let latest_status = Arc::new(Mutex::new(MappedStatus {
            color: LightColor::Yellow,
            tooltip: format!("nexus-mcp :{mcp_port} · 启动中…"),
            tunnel_configured: false,
            tunnel_running: false,
        }));

        let handle_for_ready = Arc::clone(&handle_slot);
        let status_for_poll = Arc::clone(&latest_status);
        let stop_for_poll = Arc::clone(&stop_poller);

        let handle_for_cmd = Arc::clone(&handle_slot);
        let status_for_cmd = Arc::clone(&latest_status);
        let quit_for_cmd = Arc::clone(&on_quit);
        let server_for_restart = Arc::clone(&server);
        let spec_for_restart = spec.clone();

        let initial_ui = TrayUiState {
            autostart_enabled: initial_autostart,
            ..TrayUiState::default()
        };

        let _ = run_tray_loop(
            initial_ui,
            move |h| {
                if let Ok(mut guard) = handle_for_ready.lock() {
                    *guard = Some(h);
                }
                thread::spawn(move || {
                    while !stop_for_poll.load(Ordering::Relaxed) {
                        let mapped = poll_once(panel_port, mcp_port);
                        let auto_on = autostart::startup_dir()
                            .map(|d| autostart::is_enabled_in(&d))
                            .unwrap_or(false);
                        if let Ok(mut st) = status_for_poll.lock() {
                            *st = mapped.clone();
                        }
                        h.update(to_tray_ui_state(&mapped, auto_on));
                        for _ in 0..50 {
                            if stop_for_poll.load(Ordering::Relaxed) {
                                return;
                            }
                            thread::sleep(Duration::from_millis(100));
                        }
                    }
                });
            },
            move |cmd| match cmd {
                TrayCommand::OpenPanel => open_panel_url(panel_port),
                TrayCommand::RestartService => {
                    let server_copy = Arc::clone(&server_for_restart);
                    let spec_copy = spec_for_restart.clone();
                    thread::spawn(move || {
                        let resp = http_client::post_json(
                            panel_port,
                            "/api/service",
                            r#"{"action":"restart"}"#,
                            Duration::from_secs(5),
                        );
                        // 若面板已失联（nexus-server.exe 进程已退出），由托盘宿主直接重新拉起协议层
                        let panel_ok = matches!(resp, Ok(r) if r.status == 200);
                        if !panel_ok
                            && let Ok(mut guard) = server_copy.lock()
                        {
                            if let Some(mut old) = guard.take()
                                && old.is_running()
                            {
                                let _ = old.shutdown(false, Duration::from_secs(2));
                            }
                            if let Ok(fresh) = ManagedServer::spawn(&spec_copy) {
                                *guard = Some(fresh);
                            }
                        }
                    });
                }
                TrayCommand::ToggleTunnel => {
                    let is_running = status_for_cmd
                        .lock()
                        .map(|s| s.tunnel_running)
                        .unwrap_or(false);
                    let body = if is_running {
                        r#"{"action":"stop"}"#
                    } else {
                        r#"{"action":"start"}"#
                    };
                    let handle_copy = Arc::clone(&handle_for_cmd);
                    let status_copy = Arc::clone(&status_for_cmd);
                    thread::spawn(move || {
                        let _ = http_client::post_json(
                            panel_port,
                            "/api/tunnel",
                            body,
                            Duration::from_secs(5),
                        );
                        let mapped = poll_once(panel_port, mcp_port);
                        let auto_on = autostart::startup_dir()
                            .map(|d| autostart::is_enabled_in(&d))
                            .unwrap_or(false);
                        if let Ok(mut st) = status_copy.lock() {
                            *st = mapped.clone();
                        }
                        if let Ok(guard) = handle_copy.lock()
                            && let Some(h) = *guard
                        {
                            h.update(to_tray_ui_state(&mapped, auto_on));
                        }
                    });
                }
                TrayCommand::OpenLogs => open_directory(&log_dir),
                TrayCommand::ToggleAutostart => {
                    if let Ok(dir) = autostart::startup_dir() {
                        let next = !autostart::is_enabled_in(&dir);
                        if autostart::set_enabled_in(&dir, &self_exe, next).is_ok()
                            && let Ok(guard) = handle_for_cmd.lock()
                            && let Some(h) = *guard
                            && let Ok(st) = status_for_cmd.lock()
                        {
                            h.update(to_tray_ui_state(&st, next));
                        }
                    }
                }
                TrayCommand::Exit => {
                    quit_for_cmd(true);
                }
            },
        );
        stop_poller.store(true, Ordering::Relaxed);
    }

    let inc = quit_include_tunnel.load(Ordering::SeqCst);
    shutdown_server_slot(&server, inc);
}
