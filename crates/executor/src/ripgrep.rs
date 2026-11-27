//! ripgrep 二进制发现链（grep op 的底层依赖）。
//!
//! 发现顺序（照搬 opencode `core/src/ripgrep/binary.ts` 的链路）：
//! 1. 环境变量 `NEXUS_MCP_RG` 显式指定路径（测试与手动覆盖用）；
//! 2. PATH 上查找 rg；
//! 3. 全局缓存目录（此前下载过的 rg）；
//! 4. 下载 pinned 版本：SHA-256 校验通过才落盘执行，Windows zip 用 System32
//!    自带的 bsdtar 解压（PATH 上的 GNU tar 读不了 zip；参数在临时目录内只传
//!    纯 ASCII 相对路径，避开 ANSI 代码页对中文用户名路径的坑）。
//!
//! 成功路径进程内缓存一次；失败不缓存，下次请求可重试。
//! 测试钩子：`NEXUS_MCP_RG_SKIP_DOWNLOAD` 非空时跳过缓存与下载，只查 PATH，
//! 用于在测试里模拟「机器上没有 ripgrep」。

use std::fs;
use std::io::{BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::OnceLock;
use std::thread;
use std::time::{SystemTime, UNIX_EPOCH};

use sha2::{Digest, Sha256};

const RG_VERSION: &str = "15.1.0";
const INSTALL_HINT: &str =
    "请安装 ripgrep（Windows: winget install BurntSushi.ripgrep.MSVC；macOS: brew install ripgrep）或将其加入 PATH 后重试";

/// 当前平台的 ripgrep 发行包：目标三元组、扩展名与官方发布的 SHA-256。
struct PlatformAsset {
    triple: &'static str,
    archive_ext: &'static str,
    sha256: &'static str,
}

/// SHA-256 值来自 ripgrep 15.1.0 发布时附带的 `<asset>.sha256` 文件
/// （与 opencode `core/src/ripgrep/binary.ts` 的常量表一致）。
fn platform_asset() -> Option<PlatformAsset> {
    let (os, arch) = (std::env::consts::OS, std::env::consts::ARCH);
    let (triple, archive_ext, sha256) = match (os, arch) {
        ("windows", "x86_64") => (
            "x86_64-pc-windows-msvc",
            "zip",
            "124510b94b6baa3380d051fdf4650eaa80a302c876d611e9dba0b2e18d87493a",
        ),
        ("windows", "aarch64") => (
            "aarch64-pc-windows-msvc",
            "zip",
            "00d931fb5237c9696ca49308818edb76d8eb6fc132761cb2a1bd616b2df02f8e",
        ),
        ("windows", "x86") => (
            "i686-pc-windows-msvc",
            "zip",
            "725be85a1e8f92878a548f40ee4f6df64bc93b809586462b3c6d884e1de1e83a",
        ),
        ("macos", "aarch64") => (
            "aarch64-apple-darwin",
            "tar.gz",
            "378e973289176ca0c6054054ee7f631a065874a352bf43f0fa60ef079b6ba715",
        ),
        ("macos", "x86_64") => (
            "x86_64-apple-darwin",
            "tar.gz",
            "64811cb24e77cac3057d6c40b63ac9becf9082eedd54ca411b475b755d334882",
        ),
        ("linux", "x86_64") => (
            "x86_64-unknown-linux-musl",
            "tar.gz",
            "1c9297be4a084eea7ecaedf93eb03d058d6faae29bbc57ecdaf5063921491599",
        ),
        ("linux", "aarch64") => (
            "aarch64-unknown-linux-gnu",
            "tar.gz",
            "2b661c6ef508e902f388e9098d9c4c5aca72c87b55922d94abdba830b4dc885e",
        ),
        _ => return None,
    };
    Some(PlatformAsset { triple, archive_ext, sha256 })
}

fn rg_binary_name() -> &'static str {
    if cfg!(windows) { "rg.exe" } else { "rg" }
}

/// 全局缓存目录：Windows `%LOCALAPPDATA%\nexus-mcp\bin`，Unix `$XDG_CACHE_HOME`
/// 或 `~/.cache` 下的 `nexus-mcp/bin`。
fn cache_bin_dir() -> Option<PathBuf> {
    if cfg!(windows) {
        let local = std::env::var("LOCALAPPDATA").ok()?;
        Some(PathBuf::from(local).join("nexus-mcp").join("bin"))
    } else {
        let base = match std::env::var("XDG_CACHE_HOME").ok() {
            Some(dir) if !dir.trim().is_empty() => PathBuf::from(dir),
            _ => PathBuf::from(std::env::var("HOME").ok()?.trim()).join(".cache"),
        };
        Some(base.join("nexus-mcp").join("bin"))
    }
}

/// 在 PATH 各目录里找 rg 可执行文件。
pub(crate) fn find_in_path() -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    let separator = if cfg!(windows) { ';' } else { ':' };
    for dir in path.to_string_lossy().split(separator) {
        if dir.is_empty() {
            continue;
        }
        let candidate = Path::new(dir).join(rg_binary_name());
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut hex = String::with_capacity(digest.len() * 2);
    for byte in digest {
        hex.push_str(&format!("{byte:02x}"));
    }
    hex
}

/// 用 curl 把发行包下载到 `bin_dir` 内。cwd 固定在 bin 目录、`-o` 只传纯 ASCII
/// 文件名：curl 按 ANSI 代码页解码参数，绝对路径里的中文用户名会变成乱码。
fn download_archive(bin_dir: &Path, filename: &str, url: &str) -> Result<PathBuf, String> {
    let mut command = if cfg!(windows) {
        let system_root = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into());
        Command::new(Path::new(&system_root).join("System32").join("curl.exe"))
    } else {
        Command::new("curl")
    };
    let status = command
        .args(["-fsSL", "--connect-timeout", "15", "-m", "120", "-o", filename, url])
        .current_dir(bin_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|err| format!("启动 curl 失败: {err}"))?;
    if !status.success() {
        return Err(format!("下载 ripgrep 失败（curl 退出码 {:?}，URL: {url}）", status.code()));
    }
    Ok(bin_dir.join(filename))
}

/// 跑 tar 解压。stderr 起线程排空——piped 不读的话，错误输出撑满管道缓冲
/// 会让 tar 卡死在 write 上（对齐 grep 的做法）。
fn run_tar(program: &Path, args: &[&str], cwd: &Path) -> Result<(), String> {
    let mut child = Command::new(program)
        .args(args)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|err| format!("启动 tar 解压失败: {err}"))?;
    let stderr_stream = child.stderr.take().expect("stderr 已声明为 piped");
    let drainer = thread::spawn(move || {
        let mut text = String::new();
        let mut reader = BufReader::new(stderr_stream);
        let _ = reader.read_to_string(&mut text);
        text
    });
    let status = child.wait().map_err(|err| format!("等待 tar 退出失败: {err}"))?;
    let stderr_text = drainer.join().unwrap_or_default();
    if status.success() {
        return Ok(());
    }
    let detail = stderr_text.trim();
    if detail.is_empty() {
        Err(format!("解压 ripgrep 失败（tar 退出码 {:?}）", status.code()))
    } else {
        Err(format!("解压 ripgrep 失败（tar 退出码 {:?}）: {detail}", status.code()))
    }
}

/// 校验下载包的 SHA-256 后解压，把 rg 拷贝到缓存目录并返回其路径。
fn verify_and_extract(bin_dir: &Path, archive: &Path, asset: &PlatformAsset) -> Result<PathBuf, String> {
    let bytes = fs::read(archive).map_err(|err| format!("读取下载包失败: {err}"))?;
    let actual = sha256_hex(&bytes);
    if actual != asset.sha256 {
        let _ = fs::remove_file(archive);
        return Err(format!(
            "ripgrep 下载包 SHA-256 校验失败：预期 {}，实际 {actual}，已删除下载包。",
            asset.sha256
        ));
    }

    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let extract_dir = bin_dir.join(format!("ripgrep-extract-{stamp}"));
    fs::create_dir_all(&extract_dir).map_err(|err| format!("创建解压目录失败: {err}"))?;

    let extract_result: Result<(), String> = if asset.archive_ext == "zip" {
        // Windows zip 必须用 System32 自带的 bsdtar：PATH 上的 GNU tar 读不了
        // zip。bsdtar 按 ANSI 代码页解码参数，所以在解压目录里只传 `..\<ASCII 文件名>`
        // 相对路径，绝对路径中的中文用户名不会到它手上。
        let system_root = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into());
        let archive_arg = format!(
            r"..\{}",
            archive.file_name().expect("下载包有文件名").to_string_lossy()
        );
        run_tar(
            &Path::new(&system_root).join("System32").join("tar.exe"),
            &["-xf", archive_arg.as_str()],
            &extract_dir,
        )
    } else {
        // Unix tar.gz：PATH 上的 tar 直接解，路径按 UTF-8 locale 处理
        let archive_arg = archive.to_string_lossy().into_owned();
        let dir_arg = extract_dir.to_string_lossy().into_owned();
        run_tar(
            Path::new("tar"),
            &["-xzf", archive_arg.as_str(), "-C", dir_arg.as_str()],
            &extract_dir,
        )
    };

    let extracted = extract_dir
        .join(format!("ripgrep-{RG_VERSION}-{}", asset.triple))
        .join(rg_binary_name());
    let result = extract_result.and_then(|()| {
        if !extracted.is_file() {
            return Err(format!("ripgrep 包里没有可执行文件: {}", extracted.display()));
        }
        let target = bin_dir.join(rg_binary_name());
        fs::copy(&extracted, &target)
            .map_err(|err| format!("安装 ripgrep 到缓存目录失败: {err}"))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(&target, fs::Permissions::from_mode(0o755));
        }
        Ok(target)
    });
    let _ = fs::remove_dir_all(&extract_dir);
    result
}

fn download_and_install(bin_dir: &Path) -> Result<PathBuf, String> {
    let Some(asset) = platform_asset() else {
        return Err(format!(
            "当前平台（{}-{}）没有预编译 ripgrep 可下载。{}",
            std::env::consts::OS,
            std::env::consts::ARCH,
            INSTALL_HINT
        ));
    };
    fs::create_dir_all(bin_dir).map_err(|err| format!("创建缓存目录失败: {err}"))?;
    let filename = format!("ripgrep-{RG_VERSION}-{}.{}", asset.triple, asset.archive_ext);
    let url = format!("https://github.com/BurntSushi/ripgrep/releases/download/{RG_VERSION}/{filename}");
    let archive = download_archive(bin_dir, &filename, &url)?;
    let result = verify_and_extract(bin_dir, &archive, &asset);
    let _ = fs::remove_file(&archive);
    result
}

/// 显式覆盖项（NEXUS_MCP_RG）的解析：设了就只认它。None 表示未设置，
/// Some(Err) 表示设置了但路径不存在。
fn resolve_explicit_override(value: Option<&str>) -> Option<Result<PathBuf, String>> {
    let trimmed = value?.trim();
    if trimmed.is_empty() {
        return None;
    }
    let path = PathBuf::from(trimmed);
    if path.is_file() {
        Some(Ok(path))
    } else {
        Some(Err(format!(
            "NEXUS_MCP_RG 指定的 ripgrep 不存在: {trimmed}"
        )))
    }
}

/// 布尔型环境变量的统一判法：非空白即真。
fn env_flag_is_set(value: Option<&str>) -> bool {
    value.is_some_and(|v| !v.trim().is_empty())
}

fn discover_rg() -> Result<PathBuf, String> {
    // 1. 显式覆盖：设了就只用它，不存在时报错（测试与手动排障用）
    if let Some(outcome) = resolve_explicit_override(std::env::var("NEXUS_MCP_RG").ok().as_deref()) {
        return outcome.map_err(|err| format!("{err}。{INSTALL_HINT}"));
    }
    // 2. PATH
    if let Some(path) = find_in_path() {
        return Ok(path);
    }
    // 测试钩子：跳过缓存与下载，模拟「机器上没有 ripgrep」
    if env_flag_is_set(std::env::var("NEXUS_MCP_RG_SKIP_DOWNLOAD").ok().as_deref()) {
        return Err(format!("ripgrep 未安装（PATH 上找不到 rg）。{INSTALL_HINT}"));
    }
    // 3. 全局缓存 → 4. 下载
    match cache_bin_dir() {
        Some(bin_dir) => {
            let cached = bin_dir.join(rg_binary_name());
            if cached.is_file() {
                return Ok(cached);
            }
            download_and_install(&bin_dir)
                .map_err(|err| format!("{err}。{INSTALL_HINT}"))
        }
        None => Err(format!(
            "ripgrep 未安装，且无法确定缓存目录（LOCALAPPDATA/HOME 未设置）。{INSTALL_HINT}"
        )),
    }
}

/// 解析 ripgrep 可执行文件路径。成功结果进程内缓存；失败每次重试。
pub fn resolve_rg() -> Result<PathBuf, String> {
    static RESOLVED: OnceLock<PathBuf> = OnceLock::new();
    if let Some(path) = RESOLVED.get() {
        return Ok(path.clone());
    }
    let resolved = discover_rg();
    if let Ok(path) = &resolved {
        let _ = RESOLVED.set(path.clone());
    }
    resolved
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sha256_hex_matches_known_vectors() {
        assert_eq!(
            sha256_hex(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn platform_asset_covers_current_platform() {
        if matches!(std::env::consts::OS, "windows" | "macos" | "linux") {
            let asset = platform_asset().expect("主流平台应有预编译 ripgrep");
            assert_eq!(asset.sha256.len(), 64);
            let expected_ext = if cfg!(windows) { "zip" } else { "tar.gz" };
            assert_eq!(asset.archive_ext, expected_ext);
        }
    }

    #[test]
    fn explicit_override_miss_reports_clearly() {
        let resolved = resolve_explicit_override(Some(r"Z:\definitely-missing\rg.exe"))
            .expect("显式覆盖应返回 Some");
        let message = resolved.expect_err("不存在的显式路径应报错");
        assert!(message.contains("NEXUS_MCP_RG"), "错误信息应点名 NEXUS_MCP_RG: {message}");
        assert!(message.contains("ripgrep"));
    }

    #[test]
    fn explicit_override_unset_is_none() {
        assert!(resolve_explicit_override(None).is_none());
        assert!(resolve_explicit_override(Some("   ")).is_none());
    }

    #[test]
    fn env_flag_treats_nonblank_as_true() {
        assert!(!env_flag_is_set(None));
        assert!(!env_flag_is_set(Some("  ")));
        assert!(env_flag_is_set(Some("1")));
        assert!(env_flag_is_set(Some("anything")));
    }
}
