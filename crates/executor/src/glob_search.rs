//! glob op：按通配符返回文件路径，`.gitignore` 感知，按修改时间从新到旧。
//!
//! 遍历参数照搬 codex `file-search` 的 `WalkBuilder` 配置（`hidden(false)` +
//! `follow_links(true)` + `require_git(true)`，见调研文档 §2.2）；匹配用
//! globset 的精确 glob 语义——不用 codex 的 nucleo 模糊评分，语义不同。
//! 排序用有界堆只保留最新的 N 条，超大目录也不会整树囤内存。

use std::cmp::Reverse;
use std::collections::BinaryHeap;
use std::fs;
use std::time::{SystemTime, UNIX_EPOCH};

use globset::Glob;
use ignore::WalkBuilder;
use serde::Deserialize;
use serde_json::{Value, json};

use super::sandbox::{Containment, classify, display_rel_prefix, resolve_search_dir};
use super::{default_max_results, error_response};

#[derive(Deserialize)]
pub struct GlobRequest {
    id: u64,
    root: String,
    path: Option<String>,
    pattern: String,
    #[serde(default = "default_max_results")]
    max_results: u64,
}

pub fn run_glob(request: &GlobRequest) -> Value {
    let id = Some(request.id);
    // 只拦全空白，pattern 本身原样下发：首尾空格是合法的 glob/正则语义，trim 会改语义
    if request.pattern.trim().is_empty() {
        return error_response(id, "pattern 不能为空");
    }
    let max_results = request.max_results.clamp(1, 1000);
    let (root_canonical, search_dir) =
        match resolve_search_dir(&request.root, request.path.as_deref(), id) {
            Ok(pair) => pair,
            Err(response) => return response,
        };
    let matcher = match Glob::new(&request.pattern) {
        Ok(glob) => glob.compile_matcher(),
        Err(err) => return error_response(id, format!("glob 模式无效: {err}")),
    };

    // codex file-search 的 walker 配置。hidden(false) 会放进隐藏条目，
    // 显式排除 .git 自身（对齐 opencode 的 --glob=!**/.git/**）；根目录本身放行，
    // 免得起点恰好叫 .git 时整棵树被滤空。follow_links(true) 下符号链接会被
    // 深入，按 read/write 同一套真实路径校验剪掉指向根外的链接，越界文件名不外泄。
    let sandbox_root = root_canonical.clone();
    let mut builder = WalkBuilder::new(&search_dir);
    builder
        .hidden(false)
        .follow_links(true)
        .require_git(true)
        .filter_entry(move |entry| {
            if entry.depth() == 0 {
                return true;
            }
            if entry.file_name() == ".git" {
                return false;
            }
            let is_symlink = fs::symlink_metadata(entry.path())
                .map(|meta| meta.file_type().is_symlink())
                .unwrap_or(false);
            if !is_symlink {
                return true;
            }
            match fs::canonicalize(entry.path()) {
                Ok(real) => classify(&sandbox_root, &real) != Containment::Outside,
                // 悬空链接按 read/write 同样的口径拒绝
                Err(_) => false,
            }
        });

    let prefix = display_rel_prefix(&root_canonical, &search_dir);
    let mut total: u64 = 0;
    // 只保留最新的 max_results 条：堆顶是最旧的一条，比它新就换进来
    let mut newest: BinaryHeap<Reverse<(SystemTime, String)>> = BinaryHeap::new();
    for entry in builder.build() {
        let Ok(entry) = entry else { continue };
        if !entry.file_type().is_some_and(|file_type| file_type.is_file()) {
            continue;
        }
        let Ok(rel) = entry.path().strip_prefix(&search_dir) else {
            continue;
        };
        let rel_str = rel.to_string_lossy().replace('\\', "/");
        if rel_str.is_empty() || !matcher.is_match(&rel_str) {
            continue;
        }
        total += 1;
        let mtime = fs::metadata(entry.path())
            .and_then(|meta| meta.modified())
            .unwrap_or(UNIX_EPOCH);
        let display = if prefix.is_empty() {
            rel_str
        } else {
            format!("{prefix}/{rel_str}")
        };
        if newest.len() < max_results as usize {
            newest.push(Reverse((mtime, display)));
        } else if let Some(Reverse((oldest, _))) = newest.peek()
            && mtime > *oldest
        {
            newest.pop();
            newest.push(Reverse((mtime, display)));
        }
    }

    let mut newest_first: Vec<(SystemTime, String)> =
        newest.into_iter().map(|Reverse(value)| value).collect();
    newest_first.sort();
    newest_first.reverse();
    let paths: Vec<String> = newest_first.into_iter().map(|(_, path)| path).collect();
    let truncated = total > paths.len() as u64;
    json!({
        "id": request.id, "ok": true,
        "paths": paths,
        "total_matches": total,
        "truncated": truncated,
    })
}
