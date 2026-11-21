//! Windows Job Object 加固：后台任务子进程 spawn 后立刻加入
//! `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` 的 job。执行器进程无论正常退出还是被
//! 硬杀，job 句柄随进程关闭，OS 会终止整棵进程树；显式终止走 `TerminateJobObject`。
//!
//! 对照 opencode process-daemon `src/service/pipe/windows.rs` 摘取，不引入
//! portable-pty。opencode 在入 job 前用 CREATE_SUSPENDED 挂起进程来堵「子进程
//! 抢先派孙进程」的竞态，但恢复主线程要全系统线程快照，实测让 job_start 慢到
//! 300ms 级（超过 200ms 验收线）。这里改为 spawn 后立刻 assign：窗口只有
//! 微秒级，而 bash 的 MSYS 运行时初始化需要几十毫秒才可能派孙进程，余量足够；
//! 显式杀树另有 taskkill /T /F 兜底（见 main.rs 的 kill_process_tree）。
//! job 环节失败时降级为普通进程，同样退回 taskkill 兜底。

use std::io;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::process::{Child, Command};

use windows_sys::Win32::Foundation::{HANDLE, INVALID_HANDLE_VALUE};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    SetInformationJobObject, TerminateJobObject,
};

/// 校验句柄有效后交给 OwnedHandle 独占管理（关闭即释放）。
fn owned_handle(handle: HANDLE) -> io::Result<OwnedHandle> {
    if handle.is_null() || handle == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: 句柄已校验非空，此后由 OwnedHandle 独占负责关闭
    Ok(unsafe { OwnedHandle::from_raw_handle(handle) })
}

pub struct JobObject(OwnedHandle);

impl JobObject {
    /// spawn 后立刻把子进程挂进 kill-on-close job。job 环节失败时降级：
    /// 子进程照常运行，返回 None，由调用方沿用 taskkill 兜底。
    pub fn spawn_managed(mut command: Command) -> io::Result<(Child, Option<JobObject>)> {
        let Some(job) = Self::create() else {
            eprintln!("nexus-executor: 创建 Job Object 失败，后台任务将以普通进程运行（树终止退回 taskkill）");
            let child = command.spawn()?;
            return Ok((child, None));
        };
        let child = command.spawn()?;
        if let Err(err) = job.assign(&child) {
            eprintln!("nexus-executor: 子进程加入 Job Object 失败: {err}");
            return Ok((child, None));
        }
        Ok((child, Some(job)))
    }

    fn create() -> Option<Self> {
        // SAFETY: 参数均为空指针（匿名 job、默认安全属性）
        let raw = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        let job = owned_handle(raw).ok()?;
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        // SAFETY: info 与 job 句柄在调用期间存活，长度与结构体一致
        let ok = unsafe {
            SetInformationJobObject(
                job.as_raw_handle(),
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const core::ffi::c_void,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        };
        if ok == 0 {
            eprintln!(
                "nexus-executor: 设置 Job Object 限制失败: {}",
                io::Error::last_os_error()
            );
            return None;
        }
        Some(JobObject(job))
    }

    fn assign(&self, child: &Child) -> io::Result<()> {
        // SAFETY: job 与子进程句柄在调用期间存活
        if unsafe { AssignProcessToJobObject(self.0.as_raw_handle(), child.as_raw_handle()) } == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }

    /// 终止 job 里的全部进程（含主进程已退出但还握着管道的后代）。
    pub fn terminate(&self) -> bool {
        // SAFETY: job 句柄存活
        unsafe { TerminateJobObject(self.0.as_raw_handle(), 1) != 0 }
    }
}
