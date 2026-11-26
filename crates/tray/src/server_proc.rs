//! 协议层子进程监管：无窗口拉起同目录 nexus-server.exe 并纳入 Windows Job Object，
//! 退出时先发面板优雅关停请求，超时后通过 Job Object 强制树杀兜底。

use std::io;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use crate::http_client;

#[cfg(windows)]
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
use windows_sys::Win32::Foundation::{HANDLE, INVALID_HANDLE_VALUE};
#[cfg(windows)]
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JobObjectExtendedLimitInformation, SetInformationJobObject,
    TerminateJobObject,
};

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[cfg(windows)]
struct JobObject(OwnedHandle);

#[cfg(windows)]
impl JobObject {
    fn create() -> Option<Self> {
        // SAFETY: 匿名 job 与默认安全属性
        let raw: HANDLE = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if raw.is_null() || raw == INVALID_HANDLE_VALUE {
            return None;
        }
        // SAFETY: 句柄已校验非空
        let handle = unsafe { OwnedHandle::from_raw_handle(raw) };
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        // SAFETY: info 与 handle 有效
        let ok = unsafe {
            SetInformationJobObject(
                handle.as_raw_handle(),
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const core::ffi::c_void,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        };
        if ok == 0 {
            return None;
        }
        Some(JobObject(handle))
    }

    fn assign(&self, child: &Child) -> bool {
        // SAFETY: job 与 child 句柄存活
        unsafe { AssignProcessToJobObject(self.0.as_raw_handle(), child.as_raw_handle()) != 0 }
    }

    fn terminate(&self) -> bool {
        // SAFETY: job 句柄存活
        unsafe { TerminateJobObject(self.0.as_raw_handle(), 1) != 0 }
    }
}

#[derive(Debug, Clone)]
pub struct ServerLaunchSpec {
    pub program: PathBuf,
    pub args: Vec<String>,
    pub working_dir: PathBuf,
    pub panel_port: u16,
    pub mcp_port: u16,
    pub config_path: Option<PathBuf>,
}

pub struct ManagedServer {
    child: Child,
    #[cfg(windows)]
    job: Option<JobObject>,
    panel_port: u16,
}

impl ManagedServer {
    pub fn spawn(spec: &ServerLaunchSpec) -> io::Result<Self> {
        let mut cmd = Command::new(&spec.program);
        cmd.args(&spec.args)
            .current_dir(&spec.working_dir)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        if let Some(cfg) = &spec.config_path {
            cmd.env("NEXUS_MCP_CONFIG", cfg);
        }
        #[cfg(windows)]
        cmd.creation_flags(CREATE_NO_WINDOW);

        #[cfg(windows)]
        let job = JobObject::create();

        let child = cmd.spawn()?;

        #[cfg(windows)]
        let job = match job {
            Some(j) if j.assign(&child) => Some(j),
            _ => None,
        };

        Ok(Self {
            child,
            #[cfg(windows)]
            job,
            panel_port: spec.panel_port,
        })
    }

    pub fn pid(&self) -> u32 {
        self.child.id()
    }

    pub fn is_running(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
    }

    /// 先调面板 /api/shutdown 做优雅关停；超时未退出则用 Job Object 强制树杀兜底。
    /// 返回 true 表示优雅退出，false 表示触发了强制树杀。
    pub fn shutdown(&mut self, include_tunnel: bool, timeout: Duration) -> bool {
        let body = if include_tunnel {
            r#"{"includeTunnel":true}"#
        } else {
            r#"{"includeTunnel":false}"#
        };
        let _ = http_client::post_json(
            self.panel_port,
            "/api/shutdown",
            body,
            Duration::from_millis(800),
        );

        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline {
            if !self.is_running() {
                return true;
            }
            thread::sleep(Duration::from_millis(50));
        }

        #[cfg(windows)]
        if let Some(job) = &self.job {
            let _ = job.terminate();
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
        false
    }
}

/// 从同目录 config.json 读出 port 与 panelPort（缺失时回退默认 8787 / 8788）。
pub fn read_ports_from_config(config_path: &Path) -> (u16, u16) {
    let default_port = 8787u16;
    let Ok(text) = std::fs::read_to_string(config_path) else {
        return (default_port, default_port + 1);
    };
    let Ok(val) = serde_json::from_str::<serde_json::Value>(&text) else {
        return (default_port, default_port + 1);
    };
    let port = val
        .get("port")
        .and_then(|v| v.as_u64())
        .and_then(|n| u16::try_from(n).ok())
        .filter(|&p| p > 0)
        .unwrap_or(default_port);
    let panel_port = val
        .get("panelPort")
        .and_then(|v| v.as_u64())
        .and_then(|n| u16::try_from(n).ok())
        .filter(|&p| p > 0)
        .unwrap_or_else(|| port.saturating_add(1));
    (port, panel_port)
}
