//! 票 04 端到端测试：托盘内无缝换核（保隧道、保护 config/oauth）与 10 秒 /health 失败自动回滚。

use std::fs;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

use nexus_tray::hotswap::{CONTROL_FILE_NAME, ControlEndpointInfo};
use nexus_tray::http_client;

static SWAP_LOCK: Mutex<()> = Mutex::new(());

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

fn wait_for_control(dir: &Path, timeout: Duration) -> ControlEndpointInfo {
    let file = dir.join(CONTROL_FILE_NAME);
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if let Ok(raw) = fs::read_to_string(&file)
            && let Ok(info) = serde_json::from_str::<ControlEndpointInfo>(&raw)
        {
            return info;
        }
        thread::sleep(Duration::from_millis(50));
    }
    panic!("等待控制文件超时: {}", file.display());
}

fn post_control(port: u16, token: &str, path: &str, body: &str) -> (u16, String) {
    let mut stream =
        TcpStream::connect(("127.0.0.1", port)).expect("连接托盘控制端口");
    stream
        .set_read_timeout(Some(Duration::from_secs(3)))
        .unwrap();
    let req = format!(
        "POST {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nX-Tray-Token: {token}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    stream.write_all(req.as_bytes()).unwrap();
    let mut raw = Vec::new();
    stream.read_to_end(&mut raw).unwrap();
    let text = String::from_utf8_lossy(&raw).to_string();
    let (head, resp_body) = text.split_once("\r\n\r\n").unwrap();
    let status: u16 = head
        .lines()
        .next()
        .unwrap()
        .split_whitespace()
        .nth(1)
        .unwrap()
        .parse()
        .unwrap();
    (status, resp_body.to_string())
}

fn wait_health_contains(port: u16, needle: &str, timeout: Duration) -> String {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if let Ok(resp) = http_client::get(port, "/health", Duration::from_millis(400))
            && resp.status == 200
            && resp.body.contains(needle)
        {
            return resp.body;
        }
        thread::sleep(Duration::from_millis(80));
    }
    panic!("等待 127.0.0.1:{port}/health 包含 {needle} 超时");
}

fn make_stub_server_js(mcp_port: u16, panel_port: u16, version: &str, shutdown_log: &Path) -> String {
    format!(
        r#"
const http = require("http");
const fs = require("fs");
const mcp = http.createServer((req, res) => {{
  if (req.url === "/health") {{
    res.writeHead(200, {{ "Content-Type": "application/json" }});
    res.end(JSON.stringify({{ ok: true, version: {version:?} }}));
    return;
  }}
  res.writeHead(404);
  res.end();
}});
const panel = http.createServer((req, res) => {{
  if (req.method === "POST" && req.url === "/api/shutdown") {{
    let body = "";
    req.on("data", c => body += c);
    req.on("end", () => {{
      fs.appendFileSync({shutdown_log:?}, body + "\n");
      res.writeHead(200, {{ "Content-Type": "application/json" }});
      res.end('{{"ok":true}}');
      setTimeout(() => {{
        panel.close();
        mcp.close();
        process.exit(0);
      }}, 30);
    }});
    return;
  }}
  res.writeHead(200);
  res.end("ok");
}});
mcp.listen({mcp_port}, "127.0.0.1");
panel.listen({panel_port}, "127.0.0.1");
"#,
        shutdown_log = shutdown_log.to_string_lossy(),
    )
}

#[test]
fn in_place_hotswap_upgrades_and_bad_binary_rolls_back_preserving_user_data() {
    let _lock = SWAP_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let dir = unique_temp_dir("nexus-tray-hotswap");
    let stage = dir.join("stage");
    fs::create_dir_all(&stage).unwrap();

    let mcp_port = free_port();
    let panel_port = free_port();
    let shutdown_log = dir.join("shutdown.log");

    // 预置用户敏感配置，换核与回滚全程必须字节级不变
    let config_content = format!(r#"{{"port":{mcp_port},"panelPort":{panel_port},"token":"keep-me"}}"#);
    let oauth_content = r#"{"clients":{"c1":"keep-oauth"}}"#;
    fs::write(dir.join("config.json"), &config_content).unwrap();
    fs::write(dir.join("oauth-store.json"), oauth_content).unwrap();
    fs::write(dir.join("nexus-executor.exe"), b"exec-v1").unwrap();

    let runtime_server = dir.join("server-runtime.cjs");
    fs::write(
        &runtime_server,
        make_stub_server_js(mcp_port, panel_port, "v1", &shutdown_log),
    )
    .unwrap();

    let v2_server = stage.join("server-v2.cjs");
    fs::write(
        &v2_server,
        make_stub_server_js(mcp_port, panel_port, "v2", &shutdown_log),
    )
    .unwrap();
    let v2_exec = stage.join("nexus-executor.exe");
    fs::write(&v2_exec, b"exec-v2").unwrap();

    let bad_server = stage.join("server-bad.cjs");
    fs::write(&bad_server, "console.error('boom'); process.exit(42);\n").unwrap();
    let bad_exec = stage.join("nexus-executor-bad.exe");
    fs::write(&bad_exec, b"exec-bad").unwrap();

    let mutex_name = format!("Local\\nexus-tray-hotswap-{}", std::process::id());
    let args_json =
        serde_json::to_string(&vec![runtime_server.to_string_lossy().to_string()]).unwrap();

    let mut tray = Command::new(tray_bin())
        .env("NEXUS_TRAY_HEADLESS", "1")
        .env("NEXUS_TRAY_MUTEX", &mutex_name)
        .env("NEXUS_TRAY_MCP_PORT", mcp_port.to_string())
        .env("NEXUS_TRAY_PANEL_PORT", panel_port.to_string())
        .env("NEXUS_TRAY_SERVER_BIN", "node")
        .env("NEXUS_TRAY_SERVER_ARGS", &args_json)
        .env("NEXUS_TRAY_WORKDIR", &dir)
        .env("NEXUS_MCP_CONFIG", dir.join("config.json"))
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("启动托盘宿主");

    let ctrl = wait_for_control(&dir, Duration::from_secs(6));
    wait_health_contains(mcp_port, "\"v1\"", Duration::from_secs(6));

    // 鉴权检查：错误 token 被拒 403
    let (denied, _) = post_control(ctrl.port, "wrong-token", "/hotswap", "{}");
    assert_eq!(denied, 403);

    // 1) 正常无缝换核 v1 -> v2
    let swap_v2_body = serde_json::json!({
        "serverPath": v2_server.to_string_lossy(),
        "executorPath": v2_exec.to_string_lossy(),
        "delayMs": 200,
        "healthTimeoutMs": 5000,
    })
    .to_string();
    let (status, resp) = post_control(ctrl.port, &ctrl.token, "/hotswap", &swap_v2_body);
    assert_eq!(status, 202, "换核应立刻返回 202 Accepted: {resp}");
    assert!(resp.contains("\"queued\":true"));

    wait_health_contains(mcp_port, "\"v2\"", Duration::from_secs(8));
    let log_file = dir.join("logs").join("hotswap.log");
    let v2_deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < v2_deadline {
        if let Ok(text) = fs::read_to_string(&log_file)
            && text.contains("hotswap.success")
        {
            break;
        }
        thread::sleep(Duration::from_millis(50));
    }
    assert_eq!(fs::read(dir.join("nexus-executor.exe")).unwrap(), b"exec-v2");
    // 确认换核期间关停旧核传的是 includeTunnel: false（保隧道不断）
    let sd = fs::read_to_string(&shutdown_log).unwrap();
    assert!(sd.contains("\"includeTunnel\":false"));

    // 2) 投喂启动即崩溃的坏产物 -> 自动还原 .prev 回滚到 v2 并写可读日志
    let swap_bad_body = serde_json::json!({
        "serverPath": bad_server.to_string_lossy(),
        "executorPath": bad_exec.to_string_lossy(),
        "delayMs": 150,
        "healthTimeoutMs": 3000,
    })
    .to_string();
    let (bad_status, _) = post_control(ctrl.port, &ctrl.token, "/hotswap", &swap_bad_body);
    assert_eq!(bad_status, 202);

    // 等待自动回滚完成，hotswap.log 出现 rollback_done 且 /health 恢复 v2
    let deadline = Instant::now() + Duration::from_secs(10);
    let mut rolled_back = false;
    while Instant::now() < deadline {
        if let Ok(text) = fs::read_to_string(&log_file)
            && text.contains("hotswap.rollback_done")
        {
            rolled_back = true;
            break;
        }
        thread::sleep(Duration::from_millis(80));
    }
    assert!(rolled_back, "坏产物应触发自动回滚并记录 hotswap.log");
    wait_health_contains(mcp_port, "\"v2\"", Duration::from_secs(6));
    assert_eq!(
        fs::read(dir.join("nexus-executor.exe")).unwrap(),
        b"exec-v2",
        "执行器也应一并回滚为 v2"
    );

    // 用户数据全程字节级不变
    assert_eq!(fs::read_to_string(dir.join("config.json")).unwrap(), config_content);
    assert_eq!(
        fs::read_to_string(dir.join("oauth-store.json")).unwrap(),
        oauth_content
    );

    // 通过 /quit 优雅关闭托盘
    let (quit_status, _) = post_control(ctrl.port, &ctrl.token, "/quit", r#"{"includeTunnel":true}"#);
    assert_eq!(quit_status, 200);
    let exit = tray.wait().expect("等待托盘退出");
    assert!(exit.success());

    let _ = fs::remove_dir_all(&dir);
}
