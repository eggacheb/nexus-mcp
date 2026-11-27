//! 沙箱路径边界校验模块：统一收拢词法规范化、Windows 大小写/verbatim 前缀处理、
//! 符号链接 canonicalize 验根，以及 glob/grep/read/edit/write 的路径解析入口。

use std::fs;
use std::path::{Component, Path, PathBuf};

use serde_json::Value;

use crate::error_response;

/// 路径与根目录的包含关系。
#[derive(PartialEq)]
pub(crate) enum Containment {
    /// 目标就是根目录本身
    RootItself,
    /// 在根目录内
    Inside,
    /// 越界
    Outside,
}

/// 判定 target 与 root 的关系。两个参数必须同一种形态（要么都经 canonicalize、
/// 要么都是词法形态），否则 `\\?\` verbatim 前缀差异会造成误判。
/// Windows 文件系统大小写不敏感，比较按小写进行。
pub(crate) fn classify(root: &Path, target: &Path) -> Containment {
    #[cfg(windows)]
    {
        let r = root.to_string_lossy().to_lowercase();
        let t = target.to_string_lossy().to_lowercase();
        if t == r {
            return Containment::RootItself;
        }
        let r_trimmed = r.trim_end_matches(['\\', '/']);
        if t.starts_with(r_trimmed) && t[r_trimmed.len()..].starts_with('\\') {
            return Containment::Inside;
        }
        Containment::Outside
    }
    #[cfg(not(windows))]
    {
        if target == root {
            return Containment::RootItself;
        }
        if target.starts_with(root) {
            return Containment::Inside;
        }
        Containment::Outside
    }
}

/// 词法规范化（不触碰文件系统）：处理 `.` 与 `..`。`..` 试图退回到根之前
/// （如 `D:\..`）视为越界返回 Err。执行器只应收到绝对路径，相对形态同样按越界拒绝。
pub(crate) fn lexical_normalize(path: &Path) -> Result<PathBuf, ()> {
    let mut normalized: Vec<Component> = Vec::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => match normalized.pop() {
                Some(Component::RootDir) | Some(Component::Prefix(_)) => return Err(()),
                Some(_) => {}
                None => return Err(()),
            },
            other => normalized.push(other),
        }
    }
    Ok(normalized.into_iter().collect())
}

/// 给模型看的路径：canonicalize 产出的 `\\?\` verbatim 前缀剥掉，短一些。
pub(crate) fn display_path(path: &Path) -> String {
    let s = path.to_string_lossy();
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{rest}");
    }
    if let Some(rest) = s.strip_prefix(r"\\?\") {
        return rest.to_string();
    }
    s.into_owned()
}

/// 越界拒绝的统一话术：带上被拒绝的原始输入、真实指向与根目录。
pub(crate) fn escape_error(input: &str, real: &Path, root: &Path) -> String {
    format!(
        "路径越界，拒绝访问: {input}（实际指向 {}，超出根目录 {}）",
        display_path(real),
        display_path(root)
    )
}

/// 沙箱校验第一道：词法检查。root 必须是词法形态（与 target 同形态，避免
/// 8.3 短路径与 verbatim 前缀差异造成误判）。目标不存在时（canonicalize
/// 不可用）也能给出「越界」而不是误导性的「文件不存在」。
fn ensure_lexically_within(
    root: &Path,
    input: &str,
    target: &Path,
) -> Result<PathBuf, String> {
    let normalized = lexical_normalize(target).map_err(|()| escape_error(input, target, root))?;
    match classify(root, &normalized) {
        Containment::Outside => Err(escape_error(input, &normalized, root)),
        _ => Ok(normalized),
    }
}

/// 根目录的两种形态：词法（与请求路径同形态比较，避开 8.3 短路径/verbatim 差异）
/// 与 canonicalize（符号链接解析后的真实路径）。
pub(crate) struct SandboxRoot {
    pub(crate) lexical: PathBuf,
    pub(crate) canonical: PathBuf,
}

/// 解析沙箱根目录，失败时返回可读的响应。
pub(crate) fn resolve_root(root: &str, id: Option<u64>) -> Result<SandboxRoot, Value> {
    let path = Path::new(root);
    let lexical = match lexical_normalize(path) {
        Ok(p) => p,
        Err(()) => return Err(error_response(id, format!("根目录路径无法解析: {root}"))),
    };
    let canonical = match fs::canonicalize(path) {
        Ok(p) => p,
        Err(err) => {
            return Err(error_response(
                id,
                format!("根目录不存在或不可访问: {} ({err})", display_path(path)),
            ));
        }
    };
    Ok(SandboxRoot { lexical, canonical })
}

/// 根目录本身不可写的统一话术。
pub(crate) fn root_not_writable_error(id: Option<u64>, root: &Path) -> Value {
    error_response(
        id,
        format!(
            "根目录本身不可写，write 只能写根目录内的文件: {}",
            display_path(root)
        ),
    )
}

pub(crate) enum SandboxEntryKind {
    File,
    Directory {
        missing_prefix: &'static str,
        wrong_kind_prefix: &'static str,
        canonicalize_prefix: &'static str,
    },
    FileOrDirectory {
        missing_prefix: &'static str,
        canonicalize_prefix: &'static str,
    },
}

/// 已存在路径的统一沙箱双道校验（词法越界检查 + metadata 类型核对 + canonicalize 真实路径验根）。
pub(crate) fn resolve_existing_within_sandbox(
    root: &SandboxRoot,
    input: &str,
    expected: SandboxEntryKind,
    id: Option<u64>,
) -> Result<PathBuf, Value> {
    let raw_target = Path::new(input);
    let target = if raw_target.is_absolute() {
        raw_target.to_path_buf()
    } else {
        root.lexical.join(raw_target)
    };
    if let Err(message) = ensure_lexically_within(&root.lexical, input, &target) {
        return Err(error_response(id, message));
    }
    let metadata = match fs::metadata(&target) {
        Ok(meta) => meta,
        Err(_) => {
            let prefix = match expected {
                SandboxEntryKind::File => "文件不存在",
                SandboxEntryKind::Directory { missing_prefix, .. }
                | SandboxEntryKind::FileOrDirectory { missing_prefix, .. } => missing_prefix,
            };
            return Err(error_response(id, format!("{prefix}: {input}")));
        }
    };
    let canonicalize_prefix = match expected {
        SandboxEntryKind::File => {
            if metadata.is_dir() {
                return Err(error_response(id, format!("路径是目录，不是文件: {input}")));
            }
            "路径解析失败"
        }
        SandboxEntryKind::Directory {
            wrong_kind_prefix,
            canonicalize_prefix,
            ..
        } => {
            if !metadata.is_dir() {
                return Err(error_response(id, format!("{wrong_kind_prefix}: {input}")));
            }
            canonicalize_prefix
        }
        SandboxEntryKind::FileOrDirectory {
            canonicalize_prefix, ..
        } => canonicalize_prefix,
    };
    let canonical = match fs::canonicalize(&target) {
        Ok(path) => path,
        Err(err) => {
            return Err(error_response(
                id,
                format!("{canonicalize_prefix}: {input} ({err})"),
            ));
        }
    };
    if let Containment::Outside = classify(&root.canonical, &canonical) {
        return Err(error_response(
            id,
            escape_error(input, &canonical, &root.canonical),
        ));
    }
    Ok(canonical)
}

/// glob 专用：解析搜索起点目录（根目录或根内子目录），返回
/// (canonical 根目录, canonical 起点目录)。起点不存在或指向根外时给出可读错误。
pub(crate) fn resolve_search_dir(
    root_str: &str,
    path_str: Option<&str>,
    id: Option<u64>,
) -> Result<(PathBuf, PathBuf), Value> {
    let root = resolve_root(root_str, id)?;
    let Some(input) = path_str.map(str::trim).filter(|input| !input.is_empty()) else {
        return Ok((root.canonical.clone(), root.canonical));
    };
    let canonical = resolve_existing_within_sandbox(
        &root,
        input,
        SandboxEntryKind::Directory {
            missing_prefix: "搜索起点不存在或不是目录",
            wrong_kind_prefix: "搜索起点是文件不是目录，glob 需要目录起点",
            canonicalize_prefix: "路径解析失败",
        },
        id,
    )?;
    Ok((root.canonical, canonical))
}

pub(crate) enum GrepTarget {
    Dir(PathBuf),
    File(PathBuf),
}

/// grep 专用：搜索起点既可以是目录，也可以是沙箱根内的单个普通文件。
pub(crate) fn resolve_grep_target(
    root_str: &str,
    path_str: Option<&str>,
    id: Option<u64>,
) -> Result<(PathBuf, GrepTarget), Value> {
    let root = resolve_root(root_str, id)?;
    let Some(input) = path_str.map(str::trim).filter(|input| !input.is_empty()) else {
        return Ok((root.canonical.clone(), GrepTarget::Dir(root.canonical)));
    };
    let canonical = resolve_existing_within_sandbox(
        &root,
        input,
        SandboxEntryKind::FileOrDirectory {
            missing_prefix: "搜索起点不存在",
            canonicalize_prefix: "路径解析失败",
        },
        id,
    )?;
    let target = if fs::metadata(&canonical).map(|m| m.is_file()).unwrap_or(false) {
        GrepTarget::File(canonical)
    } else {
        GrepTarget::Dir(canonical)
    };
    Ok((root.canonical, target))
}

/// 结果路径的展示前缀：搜索起点相对沙箱根的路径（正斜杠）；起点就是根时为空串。
/// 统一以沙箱根为基准，模型可以把返回路径直接喂给 read/write。
pub(crate) fn display_rel_prefix(root_canonical: &Path, search_dir: &Path) -> String {
    search_dir
        .strip_prefix(root_canonical)
        .map(|rel| rel.to_string_lossy().replace('\\', "/"))
        .unwrap_or_default()
}

/// read 与 edit 共用的「存在性 + 沙箱两道校验」，返回 canonicalize 后的真实路径。
pub(crate) fn open_within_sandbox(
    root_str: &str,
    path_str: &str,
    id: Option<u64>,
) -> Result<PathBuf, Value> {
    if path_str.trim().is_empty() {
        return Err(error_response(id, "path 不能为空"));
    }
    let root = resolve_root(root_str, id)?;
    resolve_existing_within_sandbox(&root, path_str, SandboxEntryKind::File, id)
}
