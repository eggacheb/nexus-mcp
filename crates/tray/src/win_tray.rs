//! Windows 原生系统托盘（Shell_NotifyIconW + 隐藏消息窗口 + 内存状态灯 HICON）。

use std::cell::RefCell;
use std::ptr;

use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, POINT, WPARAM};
use windows_sys::Win32::Graphics::Gdi::{
    BI_RGB, BITMAPINFO, BITMAPINFOHEADER, CreateBitmap, CreateDIBSection, DIB_RGB_COLORS,
    DeleteObject,
};
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::UI::Shell::{
    NIF_ICON, NIF_MESSAGE, NIF_TIP, NIM_ADD, NIM_DELETE, NIM_MODIFY, NOTIFYICONDATAW,
    Shell_NotifyIconW,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    AppendMenuW, CreateIconIndirect, CreatePopupMenu, CreateWindowExW, DefWindowProcW,
    DestroyIcon, DestroyMenu, DestroyWindow, DispatchMessageW, GetCursorPos, GetMessageW, HICON,
    ICONINFO, MF_CHECKED, MF_GRAYED, MF_SEPARATOR, MF_STRING, MF_UNCHECKED, MSG, PostMessageW,
    PostQuitMessage, RegisterClassW, RegisterWindowMessageW, SetForegroundWindow, TPM_BOTTOMALIGN,
    TPM_LEFTALIGN, TPM_RIGHTBUTTON, TrackPopupMenu, TranslateMessage, WM_APP, WM_COMMAND,
    WM_DESTROY, WM_LBUTTONDBLCLK, WM_RBUTTONUP, WNDCLASSW,
};

const WM_TRAY_ICON: u32 = WM_APP + 1;
const WM_TRAY_UPDATE: u32 = WM_APP + 2;
const WM_TRAY_QUIT: u32 = WM_APP + 3;
const TRAY_UID: u32 = 1;

pub const CMD_OPEN_PANEL: u16 = 1001;
pub const CMD_RESTART_SERVICE: u16 = 1002;
pub const CMD_TOGGLE_TUNNEL: u16 = 1003;
pub const CMD_OPEN_LOGS: u16 = 1004;
pub const CMD_TOGGLE_AUTOSTART: u16 = 1005;
pub const CMD_EXIT: u16 = 1006;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrayColor {
    Green,
    Yellow,
    Red,
}

#[derive(Debug, Clone)]
pub struct TrayUiState {
    pub color: TrayColor,
    pub tooltip: String,
    pub tunnel_configured: bool,
    pub tunnel_running: bool,
    pub autostart_enabled: bool,
}

impl Default for TrayUiState {
    fn default() -> Self {
        Self {
            color: TrayColor::Yellow,
            tooltip: "nexus-mcp 启动中…".to_string(),
            tunnel_configured: false,
            tunnel_running: false,
            autostart_enabled: false,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrayCommand {
    OpenPanel,
    RestartService,
    ToggleTunnel,
    OpenLogs,
    ToggleAutostart,
    Exit,
}

struct WindowCtx {
    state: TrayUiState,
    icons: [HICON; 3],
    taskbar_created_msg: u32,
    on_command: Box<dyn Fn(TrayCommand)>,
}

thread_local! {
    static CTX: RefCell<Option<WindowCtx>> = const { RefCell::new(None) };
}

fn wide_null(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// 生成 16x16 抗锯齿纯色圆点 HICON（BGRA），无需外部 .ico 资源文件。
fn create_circle_icon(r: u8, g: u8, b: u8) -> HICON {
    const SIZE: i32 = 16;
    let mut bmi: BITMAPINFO = unsafe { std::mem::zeroed() };
    bmi.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
    bmi.bmiHeader.biWidth = SIZE;
    bmi.bmiHeader.biHeight = -SIZE; // top-down
    bmi.bmiHeader.biPlanes = 1;
    bmi.bmiHeader.biBitCount = 32;
    bmi.bmiHeader.biCompression = BI_RGB;

    let mut bits: *mut core::ffi::c_void = ptr::null_mut();
    // SAFETY: bmi 已初始化，bits 接收分配的像素缓冲指针
    let hbm_color =
        unsafe { CreateDIBSection(ptr::null_mut(), &bmi, DIB_RGB_COLORS, &mut bits, ptr::null_mut(), 0) };
    if hbm_color.is_null() || bits.is_null() {
        return ptr::null_mut();
    }

    // SAFETY: CreateDIBSection 分配了 SIZE * SIZE * 4 字节
    let pixels = unsafe { std::slice::from_raw_parts_mut(bits as *mut u8, (SIZE * SIZE * 4) as usize) };
    let center = 7.5f32;
    let radius = 6.2f32;
    for y in 0..SIZE {
        for x in 0..SIZE {
            let dx = x as f32 - center;
            let dy = y as f32 - center;
            let dist = (dx * dx + dy * dy).sqrt();
            let alpha = if dist <= radius - 0.8 {
                255u8
            } else if dist <= radius + 0.6 {
                let t = ((radius + 0.6 - dist) / 1.4).clamp(0.0, 1.0);
                (t * 255.0) as u8
            } else {
                0u8
            };
            let idx = ((y * SIZE + x) * 4) as usize;
            // 预乘 alpha BGRA
            pixels[idx] = ((b as u16 * alpha as u16) / 255) as u8;
            pixels[idx + 1] = ((g as u16 * alpha as u16) / 255) as u8;
            pixels[idx + 2] = ((r as u16 * alpha as u16) / 255) as u8;
            pixels[idx + 3] = alpha;
        }
    }

    // 1bpp 掩码全 0（alpha 通道驱动透明）
    let mask_bytes = [0u8; 32];
    // SAFETY: 16x16 1bpp 位图大小足够
    let hbm_mask = unsafe { CreateBitmap(SIZE, SIZE, 1, 1, mask_bytes.as_ptr() as *const _) };
    let icon_info = ICONINFO {
        fIcon: 1,
        xHotspot: 0,
        yHotspot: 0,
        hbmMask: hbm_mask,
        hbmColor: hbm_color,
    };
    // SAFETY: icon_info 指向有效位图句柄
    let hicon = unsafe { CreateIconIndirect(&icon_info) };
    unsafe {
        DeleteObject(hbm_color);
        DeleteObject(hbm_mask);
    }
    hicon
}

fn color_index(c: TrayColor) -> usize {
    match c {
        TrayColor::Green => 0,
        TrayColor::Yellow => 1,
        TrayColor::Red => 2,
    }
}

fn fill_tip(buf: &mut [u16; 128], text: &str) {
    buf.fill(0);
    for (dst, src) in buf.iter_mut().take(127).zip(text.encode_utf16()) {
        *dst = src;
    }
}

fn apply_notify_icon(hwnd: HWND, action: u32, icon: HICON, tooltip: &str) {
    let mut nid: NOTIFYICONDATAW = unsafe { std::mem::zeroed() };
    nid.cbSize = std::mem::size_of::<NOTIFYICONDATAW>() as u32;
    nid.hWnd = hwnd;
    nid.uID = TRAY_UID;
    nid.uFlags = NIF_MESSAGE | NIF_ICON | NIF_TIP;
    nid.uCallbackMessage = WM_TRAY_ICON;
    nid.hIcon = icon;
    fill_tip(&mut nid.szTip, tooltip);
    // SAFETY: nid 字段与 cbSize 完整有效
    unsafe {
        Shell_NotifyIconW(action, &nid);
    }
}

fn remove_notify_icon(hwnd: HWND) {
    let mut nid: NOTIFYICONDATAW = unsafe { std::mem::zeroed() };
    nid.cbSize = std::mem::size_of::<NOTIFYICONDATAW>() as u32;
    nid.hWnd = hwnd;
    nid.uID = TRAY_UID;
    unsafe {
        Shell_NotifyIconW(NIM_DELETE, &nid);
    }
}

fn show_context_menu(hwnd: HWND, state: &TrayUiState) {
    unsafe {
        let menu = CreatePopupMenu();
        if menu.is_null() {
            return;
        }
        let open_panel = wide_null("打开控制面板");
        let restart_svc = wide_null("重启 MCP 服务");
        let tunnel_label = if state.tunnel_running {
            wide_null("停止隧道")
        } else {
            wide_null("启动隧道")
        };
        let open_logs = wide_null("打开日志目录");
        let autostart = wide_null("开机自启");
        let exit_label = wide_null("退出（同时停止服务与隧道）");

        AppendMenuW(menu, MF_STRING, CMD_OPEN_PANEL as usize, open_panel.as_ptr());
        AppendMenuW(menu, MF_STRING, CMD_RESTART_SERVICE as usize, restart_svc.as_ptr());
        let tunnel_flags = if state.tunnel_configured {
            MF_STRING
        } else {
            MF_STRING | MF_GRAYED
        };
        AppendMenuW(menu, tunnel_flags, CMD_TOGGLE_TUNNEL as usize, tunnel_label.as_ptr());
        AppendMenuW(menu, MF_SEPARATOR, 0, ptr::null());
        AppendMenuW(menu, MF_STRING, CMD_OPEN_LOGS as usize, open_logs.as_ptr());
        let autostart_flags = MF_STRING
            | if state.autostart_enabled {
                MF_CHECKED
            } else {
                MF_UNCHECKED
            };
        AppendMenuW(menu, autostart_flags, CMD_TOGGLE_AUTOSTART as usize, autostart.as_ptr());
        AppendMenuW(menu, MF_SEPARATOR, 0, ptr::null());
        AppendMenuW(menu, MF_STRING, CMD_EXIT as usize, exit_label.as_ptr());

        let mut pt = POINT { x: 0, y: 0 };
        GetCursorPos(&mut pt);
        SetForegroundWindow(hwnd);
        TrackPopupMenu(
            menu,
            TPM_LEFTALIGN | TPM_BOTTOMALIGN | TPM_RIGHTBUTTON,
            pt.x,
            pt.y,
            0,
            hwnd,
            ptr::null(),
        );
        DestroyMenu(menu);
    }
}

unsafe extern "system" fn wnd_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    let taskbar_msg = CTX.with(|cell| {
        cell.borrow()
            .as_ref()
            .map(|c| c.taskbar_created_msg)
            .unwrap_or(0)
    });
    if taskbar_msg != 0 && msg == taskbar_msg {
        CTX.with(|cell| {
            if let Some(ctx) = cell.borrow().as_ref() {
                let icon = ctx.icons[color_index(ctx.state.color)];
                apply_notify_icon(hwnd, NIM_ADD, icon, &ctx.state.tooltip);
            }
        });
        return 0;
    }

    match msg {
        WM_TRAY_ICON => {
            let event = (lparam & 0xFFFF) as u32;
            if event == WM_LBUTTONDBLCLK {
                CTX.with(|cell| {
                    if let Some(ctx) = cell.borrow().as_ref() {
                        (ctx.on_command)(TrayCommand::OpenPanel);
                    }
                });
            } else if event == WM_RBUTTONUP {
                let snapshot = CTX.with(|cell| cell.borrow().as_ref().map(|c| c.state.clone()));
                if let Some(state) = snapshot {
                    show_context_menu(hwnd, &state);
                }
            }
            0
        }
        WM_COMMAND => {
            let cmd = (wparam & 0xFFFF) as u16;
            let mapped = match cmd {
                CMD_OPEN_PANEL => Some(TrayCommand::OpenPanel),
                CMD_RESTART_SERVICE => Some(TrayCommand::RestartService),
                CMD_TOGGLE_TUNNEL => Some(TrayCommand::ToggleTunnel),
                CMD_OPEN_LOGS => Some(TrayCommand::OpenLogs),
                CMD_TOGGLE_AUTOSTART => Some(TrayCommand::ToggleAutostart),
                CMD_EXIT => Some(TrayCommand::Exit),
                _ => None,
            };
            if let Some(command) = mapped {
                CTX.with(|cell| {
                    if let Some(ctx) = cell.borrow().as_ref() {
                        (ctx.on_command)(command);
                    }
                });
            }
            0
        }
        WM_TRAY_UPDATE => {
            // SAFETY: lparam 由 TrayHandle::update 通过 Box::into_raw 传入，此处唯一接管释放
            let boxed = unsafe { Box::from_raw(lparam as *mut TrayUiState) };
            CTX.with(|cell| {
                if let Some(ctx) = cell.borrow_mut().as_mut() {
                    ctx.state = *boxed;
                    let icon = ctx.icons[color_index(ctx.state.color)];
                    apply_notify_icon(hwnd, NIM_MODIFY, icon, &ctx.state.tooltip);
                }
            });
            0
        }
        WM_TRAY_QUIT => {
            unsafe {
                DestroyWindow(hwnd);
            }
            0
        }
        WM_DESTROY => {
            remove_notify_icon(hwnd);
            unsafe {
                PostQuitMessage(0);
            }
            0
        }
        _ => unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) },
    }
}

#[derive(Clone, Copy)]
pub struct TrayHandle(isize);

unsafe impl Send for TrayHandle {}
unsafe impl Sync for TrayHandle {}

impl TrayHandle {
    pub fn update(&self, state: TrayUiState) {
        let raw = Box::into_raw(Box::new(state)) as LPARAM;
        unsafe {
            if PostMessageW(self.0 as HWND, WM_TRAY_UPDATE, 0, raw) == 0 {
                // 投递失败时回收内存，避免泄漏
                drop(Box::from_raw(raw as *mut TrayUiState));
            }
        }
    }

    pub fn quit(&self) {
        unsafe {
            PostMessageW(self.0 as HWND, WM_TRAY_QUIT, 0, 0);
        }
    }
}

/// 在当前线程创建隐藏窗口、挂载系统托盘并运行 Win32 消息循环，直到收到 quit()。
pub fn run_tray_loop(
    initial: TrayUiState,
    on_ready: impl FnOnce(TrayHandle),
    on_command: impl Fn(TrayCommand) + 'static,
) -> std::io::Result<()> {
    let class_name = wide_null("NexusMcpTrayWindowClass");
    let window_title = wide_null("nexus-mcp");
    let taskbar_msg_name = wide_null("TaskbarCreated");

    let hinstance = unsafe { GetModuleHandleW(ptr::null()) };
    let wc = WNDCLASSW {
        style: 0,
        lpfnWndProc: Some(wnd_proc),
        cbClsExtra: 0,
        cbWndExtra: 0,
        hInstance: hinstance,
        hIcon: ptr::null_mut(),
        hCursor: ptr::null_mut(),
        hbrBackground: ptr::null_mut(),
        lpszMenuName: ptr::null(),
        lpszClassName: class_name.as_ptr(),
    };
    unsafe {
        RegisterClassW(&wc);
    }

    let hwnd = unsafe {
        CreateWindowExW(
            0,
            class_name.as_ptr(),
            window_title.as_ptr(),
            0,
            0,
            0,
            0,
            0,
            ptr::null_mut(),
            ptr::null_mut(),
            hinstance,
            ptr::null(),
        )
    };
    if hwnd.is_null() {
        return Err(std::io::Error::last_os_error());
    }

    let icons = [
        create_circle_icon(22, 163, 74),  // 绿 #16a34a
        create_circle_icon(217, 119, 6),  // 黄 #d97706
        create_circle_icon(220, 38, 38),  // 红 #dc2626
    ];
    let taskbar_created_msg = unsafe { RegisterWindowMessageW(taskbar_msg_name.as_ptr()) };

    let initial_icon = icons[color_index(initial.color)];
    apply_notify_icon(hwnd, NIM_ADD, initial_icon, &initial.tooltip);

    CTX.with(|cell| {
        *cell.borrow_mut() = Some(WindowCtx {
            state: initial,
            icons,
            taskbar_created_msg,
            on_command: Box::new(on_command),
        });
    });

    on_ready(TrayHandle(hwnd as isize));

    let mut msg: MSG = unsafe { std::mem::zeroed() };
    unsafe {
        while GetMessageW(&mut msg, ptr::null_mut(), 0, 0) > 0 {
            TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }

    CTX.with(|cell| {
        if let Some(ctx) = cell.borrow_mut().take() {
            for icon in ctx.icons {
                if !icon.is_null() {
                    unsafe {
                        DestroyIcon(icon);
                    }
                }
            }
        }
    });
    Ok(())
}
