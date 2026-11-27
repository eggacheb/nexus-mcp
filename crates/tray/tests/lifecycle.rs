//! 票 02 进程级无头集成测试：单实例 Mutex 拦截、无窗口拉起子进程、优雅退出与超时 Job Object 树杀兜底。

use std::fs;
use std::io::Write;
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

static SPAWN_LOCK: Mutex<()> = Mutex::new(());

fn tray_bin() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_nexus-mcp"))
}

fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .expect("绑定临时端口")
        .local_addr()
        .unwrap()
        .port()
}

fn unique_temp_dir(prefix: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "{prefix}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::create_dir_all(&dir).expect("创建临时目录");
    dir
}

fn wait_for_file(path: &Path, timeout: Duration) -> String {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if let Ok(content) = fs::read_to_string(path)
            && !content.trim().is_empty()
        {
            return content;
        }
        thread::sleep(Duration::from_millis(50));
    }
    panic!("等待文件超时: {}", path.display());
}

#[cfg(windows)]
fn is_pid_alive(pid: u32) -> bool {
    let output = Command::new("tasklist")
        .args(["/FI", &format!("PID eq {pid}"), "/FO", "CSV", "/NH"])
        .output()
        .expect("执行 tasklist");
    let text = String::from_utf8_lossy(&output.stdout);
    text.contains(&format!("\"{pid}\""))
}

#[cfg(not(windows))]
fn is_pid_alive(_pid: u32) -> bool {
    false
}

fn wait_until_dead(pid: u32, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if !is_pid_alive(pid) {
            return true;
        }
        thread::sleep(Duration::from_millis(60));
    }
    !is_pid_alive(pid)
}

#[test]
fn single_instance_intercepts_second_launch_and_opens_panel() {
    let _lock = SPAWN_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let dir = unique_temp_dir("nexus-tray-mutex");
    let panel_port = free_port();
    let stub_script = dir.join("stub-server.cjs");
    fs::write(
        &stub_script,
        format!(
            r#"
const http = require("http");
const fs = require("fs");
const srv = http.createServer((req, res) => {{
  if (req.method === "POST" && req.url === "/api/shutdown") {{
    let body = "";
    req.on("data", c => body += c);
    req.on("end", () => {{
      fs.writeFileSync({shutdown_log:?}, body);
      res.writeHead(200, {{ "Content-Type": "application/json" }});
      res.end('{{"ok":true}}');
      setTimeout(() => process.exit(0), 30);
    }});
    return;
  }}
  res.writeHead(200);
  res.end("ok");
}});
srv.listen({panel_port}, "127.0.0.1", () => {{
  fs.writeFileSync({ready_file:?}, "ready");
}});
"#,
            shutdown_log = dir.join("shutdown.json").to_string_lossy(),
            ready_file = dir.join("ready.txt").to_string_lossy(),
        ),
    )
    .unwrap();

    let mutex_name = format!("Local\\nexus-tray-test-{}", std::process::id());
    let pid_file = dir.join("child.pid");
    let open_url_log = dir.join("open-url.txt");
    let args_json = serde_json::to_string(&vec![stub_script.to_string_lossy().to_string()]).unwrap();

    let mut first = Command::new(tray_bin())
        .env("NEXUS_TRAY_HEADLESS", "1")
        .env("NEXUS_TRAY_MUTEX", &mutex_name)
        .env("NEXUS_TRAY_PANEL_PORT", panel_port.to_string())
        .env("NEXUS_TRAY_SERVER_BIN", "node")
        .env("NEXUS_TRAY_SERVER_ARGS", &args_json)
        .env("NEXUS_TRAY_WORKDIR", &dir)
        .env("NEXUS_TRAY_CHILD_PID_FILE", &pid_file)
        .env("NEXUS_TRAY_NO_BROWSER", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("启动首个托盘实例");

    let _ = wait_for_file(&dir.join("ready.txt"), Duration::from_secs(6));
    let child_pid: u32 = wait_for_file(&pid_file, Duration::from_secs(3))
        .trim()
        .parse()
        .unwrap();
    assert!(is_pid_alive(child_pid), "子进程应正在运行");

    // 第二个实例应撞单实例锁，记录打开面板 URL 后立即退出
    let status = Command::new(tray_bin())
        .env("NEXUS_TRAY_HEADLESS", "1")
        .env("NEXUS_TRAY_MUTEX", &mutex_name)
        .env("NEXUS_TRAY_PANEL_PORT", panel_port.to_string())
        .env("NEXUS_TRAY_OPEN_URL_LOG", &open_url_log)
        .status()
        .expect("启动第二个托盘实例");
    assert!(status.success());
    let recorded = fs::read_to_string(&open_url_log).expect("应记录打开面板 URL");
    assert_eq!(recorded.trim(), format!("http://127.0.0.1:{panel_port}"));

    // 通知首个实例退出，验证走 /api/shutdown(includeTunnel: true) 优雅退出
    writeln!(first.stdin.as_mut().unwrap(), "quit").unwrap();
    let exit = first.wait().expect("等待首个实例退出");
    assert!(exit.success());
    assert!(wait_until_dead(child_pid, Duration::from_secs(5)));

    let shutdown_body = fs::read_to_string(dir.join("shutdown.json")).expect("应收到优雅关停请求");
    assert!(shutdown_body.contains("\"includeTunnel\":true"));

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn unresponsive_server_is_tree_killed_after_timeout_without_orphans() {
    let _lock = SPAWN_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let dir = unique_temp_dir("nexus-tray-kill");
    let panel_port = free_port();
    let grandchild_pid_file = dir.join("grandchild.pid");
    let stub_script = dir.join("hang-server.cjs");
    // 故意不监听 panel_port，并再派生一个孙进程，验证 Job Object 树杀兜底零孤儿
    fs::write(
        &stub_script,
        format!(
            r#"
const {{ spawn }} = require("child_process");
const fs = require("fs");
const grand = spawn(process.execPath, ["-e", "setInterval(() => {{}}, 1000)"], {{ stdio: "ignore" }});
fs.writeFileSync({gc_file:?}, String(grand.pid));
setInterval(() => {{}}, 1000);
"#,
            gc_file = grandchild_pid_file.to_string_lossy(),
        ),
    )
    .unwrap();

    let mutex_name = format!("Local\\nexus-tray-kill-{}", std::process::id());
    let pid_file = dir.join("child.pid");
    let args_json = serde_json::to_string(&vec![stub_script.to_string_lossy().to_string()]).unwrap();

    let mut tray = Command::new(tray_bin())
        .env("NEXUS_TRAY_HEADLESS", "1")
        .env("NEXUS_TRAY_MUTEX", &mutex_name)
        .env("NEXUS_TRAY_PANEL_PORT", panel_port.to_string())
        .env("NEXUS_TRAY_SHUTDOWN_TIMEOUT_MS", "400")
        .env("NEXUS_TRAY_SERVER_BIN", "node")
        .env("NEXUS_TRAY_SERVER_ARGS", &args_json)
        .env("NEXUS_TRAY_WORKDIR", &dir)
        .env("NEXUS_TRAY_CHILD_PID_FILE", &pid_file)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("启动托盘实例");

    let child_pid: u32 = wait_for_file(&pid_file, Duration::from_secs(5))
        .trim()
        .parse()
        .unwrap();
    let grandchild_pid: u32 = wait_for_file(&grandchild_pid_file, Duration::from_secs(5))
        .trim()
        .parse()
        .unwrap();
    assert!(is_pid_alive(child_pid));
    assert!(is_pid_alive(grandchild_pid));

    writeln!(tray.stdin.as_mut().unwrap(), "quit").unwrap();
    let exit = tray.wait().expect("等待托盘退出");
    assert!(exit.success());

    assert!(
        wait_until_dead(child_pid, Duration::from_secs(5)),
        "子进程应被树杀"
    );
    assert!(
        wait_until_dead(grandchild_pid, Duration::from_secs(5)),
        "孙进程应随 Job Object 一起被树杀，无孤儿残留"
    );

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn cold_start_opens_panel_when_ready_unless_minimized() {
    let _lock = SPAWN_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let dir = unique_temp_dir("nexus-tray-autoopen");
    let panel_port = free_port();
    let stub_script = dir.join("stub-panel.cjs");
    fs::write(
        &stub_script,
        format!(
            r#"
const http = require("http");
const fs = require("fs");
const srv = http.createServer((req, res) => {{
  if (req.method === "POST" && req.url === "/api/shutdown") {{
    res.writeHead(200, {{ "Content-Type": "application/json" }});
    res.end('{{"ok":true}}');
    setTimeout(() => process.exit(0), 20);
    return;
  }}
  if (req.url === "/api/status") {{
    res.writeHead(200, {{ "Content-Type": "application/json" }});
    res.end('{{"service":{{"state":"running"}}}}');
    return;
  }}
  res.writeHead(200);
  res.end("ok");
}});
srv.listen({panel_port}, "127.0.0.1", () => {{
  fs.writeFileSync({ready_file:?}, "ready");
}});
"#,
            ready_file = dir.join("ready.txt").to_string_lossy(),
        ),
    )
    .unwrap();

    let args_json = serde_json::to_string(&vec![stub_script.to_string_lossy().to_string()]).unwrap();

    // 1. 普通冷启动（不带 --minimized）：面板就绪后自动记录打开面板 URL
    let open_cold = dir.join("open-cold.txt");
    let mutex_cold = format!("Local\\nexus-tray-cold-{}", std::process::id());
    let mut cold = Command::new(tray_bin())
        .env("NEXUS_TRAY_HEADLESS", "1")
        .env("NEXUS_TRAY_MUTEX", &mutex_cold)
        .env("NEXUS_TRAY_PANEL_PORT", panel_port.to_string())
        .env("NEXUS_TRAY_SERVER_BIN", "node")
        .env("NEXUS_TRAY_SERVER_ARGS", &args_json)
        .env("NEXUS_TRAY_WORKDIR", &dir)
        .env("NEXUS_TRAY_OPEN_URL_LOG", &open_cold)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("启动普通冷启动托盘");

    let recorded = wait_for_file(&open_cold, Duration::from_secs(6));
    assert_eq!(recorded.trim(), format!("http://127.0.0.1:{panel_port}"));
    writeln!(cold.stdin.as_mut().unwrap(), "quit").unwrap();
    assert!(cold.wait().expect("等待普通冷启动退出").success());

    // 2. 带 --minimized 启动：面板就绪后也不触发打开浏览器
    let _ = fs::remove_file(dir.join("ready.txt"));
    let open_min = dir.join("open-min.txt");
    let mutex_min = format!("Local\\nexus-tray-min-{}", std::process::id());
    let mut min_proc = Command::new(tray_bin())
        .arg("--minimized")
        .env("NEXUS_TRAY_HEADLESS", "1")
        .env("NEXUS_TRAY_MUTEX", &mutex_min)
        .env("NEXUS_TRAY_PANEL_PORT", panel_port.to_string())
        .env("NEXUS_TRAY_SERVER_BIN", "node")
        .env("NEXUS_TRAY_SERVER_ARGS", &args_json)
        .env("NEXUS_TRAY_WORKDIR", &dir)
        .env("NEXUS_TRAY_OPEN_URL_LOG", &open_min)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("启动 --minimized 托盘");

    let _ = wait_for_file(&dir.join("ready.txt"), Duration::from_secs(6));
    thread::sleep(Duration::from_millis(500));
    assert!(!open_min.exists(), "--minimized 启动不应自动打开浏览器面板");

    writeln!(min_proc.stdin.as_mut().unwrap(), "quit").unwrap();
    assert!(min_proc.wait().expect("等待 --minimized 退出").success());

    let _ = fs::remove_dir_all(&dir);
}
