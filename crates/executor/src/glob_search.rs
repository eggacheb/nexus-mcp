//! glob op：按通配符返回文件路径，`.gitignore` 感知，按修改时间从新到旧。
//!
//! 遍历参数照搬 codex `file-search` 的 `WalkBuilder` 配置（`hidden(false)` +
//! `follow_links(true)` + `require_git(true)`，见调研文档 §2.2）；匹配用
//! globset 的精确 glob 语义——不用 codex 的 nucleo 模糊评分，语义不同。
//! 排序用有界堆只保留最新的 N 条，超大目录也不会整树囤内存。

use std::cmp::Reverse;
use std::collections::BinaryHeap;
use std::fs;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use globset::Glob;
use ignore::{WalkBuilder, WalkState};
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
    // 优先用 entry.path_is_symlink() 复用目录遍历已读到的属性，避免对每个普通文件多做一次 stat。
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
            if !entry.path_is_symlink() {
                return true;
            }
            match fs::canonicalize(entry.path()) {
                Ok(real) => classify(&sandbox_root, &real) != Containment::Outside,
                // 悬空链接按 read/write 同样的口径拒绝
                Err(_) => false,
            }
        });

    let prefix = Arc::new(display_rel_prefix(&root_canonical, &search_dir));
    let search_dir = Arc::new(search_dir);
    let matcher = Arc::new(matcher);
    let max_keep = max_results as usize;

    struct SharedAcc {
        total: u64,
        newest: BinaryHeap<Reverse<(SystemTime, String)>>,
    }

    struct LocalAcc {
        total: u64,
        newest: BinaryHeap<Reverse<(SystemTime, String)>>,
        max_keep: usize,
        shared: Arc<Mutex<SharedAcc>>,
    }

    impl LocalAcc {
        fn push(&mut self, mtime: SystemTime, display: String) {
            self.total += 1;
            if self.newest.len() < self.max_keep {
                self.newest.push(Reverse((mtime, display)));
            } else if let Some(Reverse((oldest, _))) = self.newest.peek()
                && mtime > *oldest
            {
                self.newest.pop();
                self.newest.push(Reverse((mtime, display)));
            }
        }
    }

    impl Drop for LocalAcc {
        fn drop(&mut self) {
            if self.total == 0 {
                return;
            }
            let mut shared = self.shared.lock().expect("glob 聚合锁不应中毒");
            shared.total += self.total;
            for item in self.newest.drain() {
                if shared.newest.len() < self.max_keep {
                    shared.newest.push(item);
                } else if let Some(Reverse((oldest, _))) = shared.newest.peek()
                    && item.0.0 > *oldest
                {
                    shared.newest.pop();
                    shared.newest.push(item);
                }
            }
        }
    }

    let shared = Arc::new(Mutex::new(SharedAcc {
        total: 0,
        newest: BinaryHeap::new(),
    }));

    builder.build_parallel().run(|| {
        let search_dir = Arc::clone(&search_dir);
        let matcher = Arc::clone(&matcher);
        let prefix = Arc::clone(&prefix);
        let mut local = LocalAcc {
            total: 0,
            newest: BinaryHeap::new(),
            max_keep,
            shared: Arc::clone(&shared),
        };
        Box::new(move |entry| {
            let Ok(entry) = entry else {
                return WalkState::Continue;
            };
            if !entry.file_type().is_some_and(|file_type| file_type.is_file()) {
                return WalkState::Continue;
            }
            let Ok(rel) = entry.path().strip_prefix(search_dir.as_ref()) else {
                return WalkState::Continue;
            };
            let rel_str = rel.to_string_lossy().replace('\\', "/");
            if rel_str.is_empty() || !matcher.is_match(&rel_str) {
                return WalkState::Continue;
            }
            let mtime = entry
                .metadata()
                .ok()
                .and_then(|meta| meta.modified().ok())
                .unwrap_or(UNIX_EPOCH);
            let display = if prefix.is_empty() {
                rel_str
            } else {
                format!("{prefix}/{rel_str}")
            };
            local.push(mtime, display);
            WalkState::Continue
        })
    });

    let acc = shared.lock().expect("glob 聚合锁不应中毒");
    let total = acc.total;
    let mut newest_first: Vec<(SystemTime, String)> =
        acc.newest.iter().map(|Reverse(value)| value.clone()).collect();
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
