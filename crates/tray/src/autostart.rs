//! 开机自启快捷方式管理：仅读写当前用户启动文件夹里的 nexus-mcp.lnk，不触碰系统注册表。

use std::env;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

pub const SHORTCUT_NAME: &str = "nexus-mcp.lnk";
/// 开机自启快捷方式附带静默参数，避免开机自动弹出浏览器面板
pub const AUTOSTART_ARGS: &str = "--minimized";

/// 解析当前用户启动文件夹；允许 NEXUS_TRAY_STARTUP_DIR 覆盖以便测试隔离。
pub fn startup_dir() -> io::Result<PathBuf> {
    if let Ok(override_dir) = env::var("NEXUS_TRAY_STARTUP_DIR") {
        let trimmed = override_dir.trim();
        if !trimmed.is_empty() {
            return Ok(PathBuf::from(trimmed));
        }
    }
    let appdata = env::var("APPDATA")
        .map_err(|_| io::Error::new(io::ErrorKind::NotFound, "找不到 APPDATA 环境变量"))?;
    Ok(PathBuf::from(appdata)
        .join("Microsoft")
        .join("Windows")
        .join("Start Menu")
        .join("Programs")
        .join("Startup"))
}

pub fn shortcut_path(dir: &Path) -> PathBuf {
    dir.join(SHORTCUT_NAME)
}

pub fn is_enabled_in(dir: &Path) -> bool {
    shortcut_path(dir).exists()
}

pub fn set_enabled_in(dir: &Path, target_exe: &Path, enabled: bool) -> io::Result<()> {
    let lnk = shortcut_path(dir);
    if !enabled {
        if lnk.exists() {
            fs::remove_file(&lnk)?;
        }
        return Ok(());
    }
    fs::create_dir_all(dir)?;
    create_windows_shortcut(&lnk, target_exe)
}

#[cfg(windows)]
fn escape_ps_single(s: &str) -> String {
    s.replace('\'', "''")
}

#[cfg(windows)]
fn create_windows_shortcut(lnk: &Path, target_exe: &Path) -> io::Result<()> {
    let lnk_str = escape_ps_single(&lnk.to_string_lossy());
    let target_str = escape_ps_single(&target_exe.to_string_lossy());
    let workdir = target_exe
        .parent()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default();
    let workdir_str = escape_ps_single(&workdir);

    let script = format!(
        "$ws = New-Object -ComObject WScript.Shell; \
         $sc = $ws.CreateShortcut('{lnk_str}'); \
         $sc.TargetPath = '{target_str}'; \
         $sc.Arguments = '{AUTOSTART_ARGS}'; \
         $sc.WorkingDirectory = '{workdir_str}'; \
         $sc.Save()"
    );

    let run = |exe: &str| {
        Command::new(exe)
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-WindowStyle",
                "Hidden",
                "-Command",
                &script,
            ])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .creation_flags(CREATE_NO_WINDOW)
            .output()
    };

    let output = match run("pwsh.exe") {
        Ok(out) if out.status.success() => out,
        Ok(_) => run("powershell.exe")?,
        Err(err) if err.kind() == io::ErrorKind::NotFound => run("powershell.exe")?,
        Err(err) => return Err(err),
    };

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(io::Error::other(format!("创建快捷方式失败: {}", stderr.trim())));
    }
    if !lnk.exists() {
        return Err(io::Error::other("快捷方式创建命令成功但未生成 .lnk 文件"));
    }
    Ok(())
}

#[cfg(not(windows))]
fn create_windows_shortcut(lnk: &Path, target_exe: &Path) -> io::Result<()> {
    fs::write(lnk, target_exe.to_string_lossy().as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn toggle_autostart_creates_and_removes_lnk_in_temp_dir() {
        let dir = env::temp_dir().join(format!(
            "nexus-tray-startup-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();
        let fake_exe = dir.join("nexus-mcp.exe");
        fs::write(&fake_exe, b"stub").unwrap();

        assert!(!is_enabled_in(&dir));
        set_enabled_in(&dir, &fake_exe, true).expect("应成功创建快捷方式");
        assert!(is_enabled_in(&dir));
        let lnk = shortcut_path(&dir);
        assert!(lnk.metadata().unwrap().len() > 0);

        #[cfg(windows)]
        {
            let lnk_str = escape_ps_single(&lnk.to_string_lossy());
            let read_script = format!(
                "$ws = New-Object -ComObject WScript.Shell; \
                 Write-Output $ws.CreateShortcut('{lnk_str}').Arguments"
            );
            let out = match Command::new("pwsh.exe")
                .args(["-NoProfile", "-NonInteractive", "-Command", &read_script])
                .output()
            {
                Ok(out) if out.status.success() => out,
                _ => Command::new("powershell.exe")
                    .args(["-NoProfile", "-NonInteractive", "-Command", &read_script])
                    .output()
                    .expect("读取快捷方式参数"),
            };
            assert!(out.status.success());
            assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), AUTOSTART_ARGS);
        }

        set_enabled_in(&dir, &fake_exe, false).expect("应成功删除快捷方式");
        assert!(!is_enabled_in(&dir));

        // 幂等删除不报错
        set_enabled_in(&dir, &fake_exe, false).expect("重复关闭不应报错");

        let _ = fs::remove_dir_all(&dir);
    }
}
