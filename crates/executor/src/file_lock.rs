//! 进程内按文件路径细粒度写锁（参考 opencode `KeyedMutex`）。
//!
//! 同一归一化路径的 `write` / `edit` 串行执行「读 → 匹配/准备 → 落盘」，
//! 不同文件之间、读写之间以及与 `bash` 之间互不阻塞；引用计数归零自动清理条目。

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Condvar, Mutex, OnceLock};

struct Slot {
    locked: bool,
    /// 当前持有者 + 等待者总数；归零时从表中移除条目，避免长跑累积内存
    users: usize,
}

pub(crate) struct FileLockTable {
    state: Mutex<HashMap<String, Slot>>,
    cvar: Condvar,
}

impl FileLockTable {
    fn new() -> Self {
        Self {
            state: Mutex::new(HashMap::new()),
            cvar: Condvar::new(),
        }
    }

    fn normalize_key(path: &Path) -> String {
        let display = crate::display_path(path);
        #[cfg(windows)]
        {
            display.to_lowercase()
        }
        #[cfg(not(windows))]
        {
            display
        }
    }

    pub(crate) fn acquire(&self, path: &Path) -> FileLockGuard<'_> {
        let key = Self::normalize_key(path);
        let mut map = self.state.lock().expect("文件锁表不应中毒");
        let entry = map
            .entry(key.clone())
            .or_insert(Slot { locked: false, users: 0 });
        entry.users += 1;
        while map.get(&key).map(|slot| slot.locked).unwrap_or(false) {
            map = self.cvar.wait(map).expect("文件锁条件变量不应中毒");
        }
        if let Some(slot) = map.get_mut(&key) {
            slot.locked = true;
        }
        FileLockGuard { table: self, key }
    }

    #[cfg(test)]
    pub(crate) fn len(&self) -> usize {
        self.state.lock().expect("文件锁表不应中毒").len()
    }
}

pub(crate) struct FileLockGuard<'a> {
    table: &'a FileLockTable,
    key: String,
}

impl Drop for FileLockGuard<'_> {
    fn drop(&mut self) {
        if let Ok(mut map) = self.table.state.lock() {
            if let Some(slot) = map.get_mut(&self.key) {
                slot.locked = false;
                slot.users = slot.users.saturating_sub(1);
                if slot.users == 0 {
                    map.remove(&self.key);
                }
            }
            self.table.cvar.notify_all();
        }
    }
}

pub(crate) fn table() -> &'static FileLockTable {
    static TABLE: OnceLock<FileLockTable> = OnceLock::new();
    TABLE.get_or_init(FileLockTable::new)
}

pub(crate) fn acquire(path: &Path) -> FileLockGuard<'static> {
    table().acquire(path)
}
