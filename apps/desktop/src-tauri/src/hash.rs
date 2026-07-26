//! 元 PNG の SHA-256 計算と、その結果のローカルキャッシュ。
//!
//! ハッシュはサーバー上の一意キーになるため、同じファイルには必ず同じ値が必要になる。
//! 数百 MB を毎回読み直すのは重いので、(mtime, size) が変わらない限り
//! SQLite のキャッシュを再利用する。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::UNIX_EPOCH;

use rayon::prelude::*;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager};

/// ハッシュ計算の進捗イベント名。
pub const HASH_PROGRESS_EVENT: &str = "hash_progress";

/// 一度に読み込むバイト数。大きい PNG でもメモリを一定に保つ。
const READ_CHUNK_BYTES: usize = 1024 * 1024;

/// 進捗イベントの間引き間隔。
const PROGRESS_INTERVAL: usize = 10;

/// 1ファイル分のハッシュ結果。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PhotoHash {
    pub path: String,
    pub sha256: String,
}

/// ハッシュ計算の進捗。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HashProgress {
    pub processed: usize,
    pub total: usize,
    pub current_path: String,
}

/// キャッシュの有効性を判定するためのファイル指紋。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct FileStamp {
    mtime_millis: i64,
    size: u64,
}

/// ファイルの (mtime, size) を取る。取れないファイルはキャッシュ対象外。
fn file_stamp(path: &Path) -> Option<FileStamp> {
    let meta = std::fs::metadata(path).ok()?;
    let mtime = meta.modified().ok()?.duration_since(UNIX_EPOCH).ok()?;
    Some(FileStamp {
        mtime_millis: mtime.as_millis() as i64,
        size: meta.len(),
    })
}

/// ファイルを逐次読みして SHA-256 を求める。全体をメモリに載せない。
pub fn hash_file(path: &Path) -> Result<String, String> {
    use std::io::Read;
    let mut file = std::fs::File::open(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; READ_CHUNK_BYTES];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|e| format!("{}: {e}", path.display()))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hex::encode(hasher.finalize()))
}

/// キャッシュ用の SQLite を開き、必要ならテーブルを作る。
fn open_cache(app: &AppHandle) -> Result<Connection, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("could not resolve the app data directory: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let conn = Connection::open(dir.join("hash-cache.db")).map_err(|e| e.to_string())?;
    conn.execute(
        "CREATE TABLE IF NOT EXISTS hash_cache (
            path   TEXT PRIMARY KEY,
            mtime  INTEGER NOT NULL,
            size   INTEGER NOT NULL,
            sha256 TEXT NOT NULL
        )",
        [],
    )
    .map_err(|e| e.to_string())?;
    Ok(conn)
}

/// キャッシュから (mtime, size) が一致する行だけを読み出す。
fn read_cache(conn: &Connection, paths: &[PathBuf]) -> HashMap<String, String> {
    let mut hits = HashMap::new();
    let Ok(mut stmt) = conn.prepare("SELECT mtime, size, sha256 FROM hash_cache WHERE path = ?1")
    else {
        return hits;
    };
    for path in paths {
        let Some(stamp) = file_stamp(path) else {
            continue;
        };
        let key = path.to_string_lossy().into_owned();
        let row = stmt.query_row([&key], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, String>(2)?,
            ))
        });
        if let Ok((mtime, size, sha256)) = row {
            // 更新時刻かサイズが変わっていればキャッシュは無効。
            if mtime == stamp.mtime_millis && size as u64 == stamp.size {
                hits.insert(key, sha256);
            }
        }
    }
    hits
}

/// 計算結果をまとめてキャッシュへ書き戻す。
fn write_cache(
    conn: &mut Connection,
    entries: &[(String, FileStamp, String)],
) -> Result<(), String> {
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    {
        let mut stmt = tx
            .prepare(
                "INSERT INTO hash_cache (path, mtime, size, sha256) VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(path) DO UPDATE SET mtime = ?2, size = ?3, sha256 = ?4",
            )
            .map_err(|e| e.to_string())?;
        for (path, stamp, sha256) in entries {
            stmt.execute(rusqlite::params![
                path,
                stamp.mtime_millis,
                stamp.size as i64,
                sha256
            ])
            .map_err(|e| e.to_string())?;
        }
    }
    tx.commit().map_err(|e| e.to_string())
}

/// 指定されたパスの SHA-256 を求める。キャッシュに当たったものは読み直さない。
#[tauri::command]
pub async fn hash_photos(app: AppHandle, paths: Vec<String>) -> Result<Vec<PhotoHash>, String> {
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let paths: Vec<PathBuf> = paths.into_iter().map(PathBuf::from).collect();
        let mut conn = open_cache(&handle)?;
        let cached = read_cache(&conn, &paths);

        let total = paths.len();
        let processed = AtomicUsize::new(0);
        // 新規計算分はキャッシュへ書き戻すため、別途集める。
        let fresh: Mutex<Vec<(String, FileStamp, String)>> = Mutex::new(Vec::new());

        let mut results: Vec<PhotoHash> = paths
            .par_iter()
            .filter_map(|path| {
                let key = path.to_string_lossy().into_owned();
                let sha256 = match cached.get(&key) {
                    Some(hit) => Some(hit.clone()),
                    None => hash_file(path).ok().inspect(|sha256| {
                        if let Some(stamp) = file_stamp(path) {
                            fresh
                                .lock()
                                .unwrap()
                                .push((key.clone(), stamp, sha256.clone()));
                        }
                    }),
                };
                let done = processed.fetch_add(1, Ordering::Relaxed) + 1;
                if done % PROGRESS_INTERVAL == 0 || done == total {
                    let _ = handle.emit(
                        HASH_PROGRESS_EVENT,
                        HashProgress {
                            processed: done,
                            total,
                            current_path: key.clone(),
                        },
                    );
                }
                sha256.map(|sha256| PhotoHash { path: key, sha256 })
            })
            .collect();

        // 入力順に揃えておくと、フロントエンドが対応付けしやすい。
        results.sort_by(|a, b| a.path.cmp(&b.path));

        let fresh = fresh.into_inner().unwrap();
        if !fresh.is_empty() {
            write_cache(&mut conn, &fresh)?;
        }
        Ok(results)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn hashes_file_contents() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.bin");
        std::fs::File::create(&path)
            .unwrap()
            .write_all(b"abc")
            .unwrap();
        // "abc" の SHA-256 は既知の値。
        assert_eq!(
            hash_file(&path).unwrap(),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }
}
