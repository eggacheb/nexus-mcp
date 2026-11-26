//! Windows 命名 Mutex 单实例锁：重复启动时立即识别已有实例。

use std::io;

#[cfg(windows)]
use std::os::windows::io::{FromRawHandle, OwnedHandle};

#[cfg(windows)]
use windows_sys::Win32::Foundation::{ERROR_ALREADY_EXISTS, GetLastError, INVALID_HANDLE_VALUE};
#[cfg(windows)]
use windows_sys::Win32::System::Threading::CreateMutexW;

pub const DEFAULT_MUTEX_NAME: &str = "Local\\nexus-mcp-tray-single-instance";

#[derive(Debug)]
pub struct SingleInstanceGuard {
    #[cfg(windows)]
    _handle: OwnedHandle,
}

#[derive(Debug)]
pub enum AcquireResult {
    Acquired(SingleInstanceGuard),
    AlreadyRunning,
}

#[cfg(windows)]
pub fn acquire(name: &str) -> io::Result<AcquireResult> {
    let wide: Vec<u16> = name.encode_utf16().chain(std::iter::once(0)).collect();
    // SAFETY: wide 为合法以 0 结尾的 UTF-16 字符串，其余参数为空指针
    let raw = unsafe { CreateMutexW(std::ptr::null(), 0, wide.as_ptr()) };
    if raw.is_null() || raw == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: CreateMutexW 返回后立即检查 GetLastError
    let err = unsafe { GetLastError() };
    // SAFETY: 句柄已校验非空，交给 OwnedHandle 托管释放
    let handle = unsafe { OwnedHandle::from_raw_handle(raw) };
    if err == ERROR_ALREADY_EXISTS {
        drop(handle);
        return Ok(AcquireResult::AlreadyRunning);
    }
    Ok(AcquireResult::Acquired(SingleInstanceGuard { _handle: handle }))
}

#[cfg(not(windows))]
pub fn acquire(_name: &str) -> io::Result<AcquireResult> {
    Ok(AcquireResult::Acquired(SingleInstanceGuard {}))
}
