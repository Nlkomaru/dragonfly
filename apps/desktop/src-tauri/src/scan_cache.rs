//! 前回の走査結果のローカルキャッシュ。
//!
//! [`crate::scanner::scan_photos`] は WalkDir と全 PNG のヘッダ読みを伴うため、
//! 起動直後は完走するまで一覧に何も出ない。そこで前回の結果を SQLite に残しておき、
//! 起動時はまずそれを返して、走査が終わったら差し替える。
//!
//! 作りは [`crate::hash`] のハッシュキャッシュ（path をキーに mtime / size で
//! 有効性を判定する）に倣う。ここでは写真そのものを毎回入れ直すので指紋は
//! 「前回の sha256 / uploaded を引き継いでよいか」の判定にだけ使う。

use std::collections::HashMap;
use std::path::Path;
use std::time::UNIX_EPOCH;

use rusqlite::Connection;
use serde::Deserialize;
use tauri::{AppHandle, Manager};

use crate::scanner::{CachedPhoto, CachedScan, Photo, ScanResult, SkippedFile};

/// キャッシュ DB のファイル名。走査し直せば作り直せるので app_cache_dir に置く。
const CACHE_FILE: &str = "scan-cache.db";

/// キャッシュの有効性を判定するためのファイル指紋。
/// hash.rs にも同じ考えの型があるが、あちらはモジュール内に閉じているので写しを持つ。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct FileStamp {
    mtime_millis: i64,
    size: u64,
}

/// ファイルの (mtime, size) を取る。取れないファイルは指紋なしとして扱う。
fn file_stamp(path: &Path) -> Option<FileStamp> {
    let meta = std::fs::metadata(path).ok()?;
    let mtime = meta.modified().ok()?.duration_since(UNIX_EPOCH).ok()?;
    Some(FileStamp {
        mtime_millis: mtime.as_millis() as i64,
        size: meta.len(),
    })
}

/// 送信状態の更新 1 件分。フロントエンドが月ごとの判定を終えるたびに送ってくる。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadStateEntry {
    /// 対象写真の絶対パス。一覧のキーと同じ値。
    pub path: String,
    /// 元 PNG の SHA-256。未計算なら null（キーごと省いてもよい）。
    #[serde(default)]
    pub sha256: Option<String>,
    pub uploaded: bool,
}

/// 引き継ぎ判定に使う、キャッシュ済み 1 行分の送信状態。
struct CachedState {
    stamp: FileStamp,
    sha256: Option<String>,
    uploaded: bool,
}

/// テーブルを用意する。既にあれば何もしない。
fn init_schema(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute(
        "CREATE TABLE IF NOT EXISTS scan_cache (
            path     TEXT PRIMARY KEY,
            mtime    INTEGER NOT NULL,
            size     INTEGER NOT NULL,
            photo    TEXT NOT NULL,
            sha256   TEXT,
            uploaded INTEGER NOT NULL
        )",
        [],
    )?;
    // 走査単位のまとめ。行は常に 1 本だけなので id を 1 に固定する。
    // root_dir は「そのとき走査した場所」で、設定から引き直すと
    // 保存先を変えた直後にキャッシュの中身と食い違うため、一緒に残す。
    conn.execute(
        "CREATE TABLE IF NOT EXISTS scan_meta (
            id            INTEGER PRIMARY KEY CHECK (id = 1),
            skipped_count INTEGER NOT NULL,
            root_dir      TEXT NOT NULL
        )",
        [],
    )?;
    // メタデータ無しで除外した PNG も指紋だけ保存し、古い月の再解析を防ぐ。
    conn.execute(
        "CREATE TABLE IF NOT EXISTS scan_skipped (
            path  TEXT PRIMARY KEY,
            mtime INTEGER NOT NULL,
            size  INTEGER NOT NULL
        )",
        [],
    )?;
    Ok(())
}

/// キャッシュ用の SQLite を開き、必要ならテーブルを作る。
fn open_cache(app: &AppHandle) -> Result<Connection, String> {
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("could not resolve the cache directory: {e}"))?;
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("could not create {}: {e}", dir.display()))?;
    let conn = Connection::open(dir.join(CACHE_FILE)).map_err(|e| e.to_string())?;
    init_schema(&conn).map_err(|e| e.to_string())?;
    Ok(conn)
}

/// キャッシュを一覧と指紋のスナップショットとして読み出す。
fn read_snapshot(conn: &Connection) -> Result<CachedScan, String> {
    let mut stmt = conn
        .prepare("SELECT path, mtime, size, photo, sha256, uploaded FROM scan_cache")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, i64>(5)?,
            ))
        })
        .map_err(|e| e.to_string())?;

    let mut photos = Vec::new();
    for row in rows {
        let (_path, mtime, size, json, sha256, uploaded) = row.map_err(|e| e.to_string())?;
        // 壊れた行は捨てるだけにする。1 行のために一覧全体を落とさない。
        let Ok(mut photo) = serde_json::from_str::<Photo>(&json) else {
            continue;
        };
        // sha256 / uploaded は列の側が正。JSON は走査時点の値のままなので必ず上書きする。
        photo.sha256 = sha256;
        photo.uploaded = uploaded != 0;
        photos.push(CachedPhoto {
            photo,
            mtime_millis: mtime,
            size: size as u64,
        });
    }

    let mut skipped_files = Vec::new();
    let mut skipped_stmt = conn
        .prepare("SELECT path, mtime, size FROM scan_skipped")
        .map_err(|e| e.to_string())?;
    let skipped_rows = skipped_stmt
        .query_map([], |row| {
            Ok(SkippedFile {
                path: row.get(0)?,
                mtime_millis: row.get(1)?,
                size: row.get::<_, i64>(2)? as u64,
            })
        })
        .map_err(|e| e.to_string())?;
    for row in skipped_rows {
        skipped_files.push(row.map_err(|e| e.to_string())?);
    }

    // 並び順は走査結果と揃える（新しい写真が先頭）。
    photos.sort_by(|a, b| b.photo.taken_at.cmp(&a.photo.taken_at));
    let meta = conn
        .query_row(
            "SELECT skipped_count, root_dir FROM scan_meta WHERE id = 1",
            [],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
        )
        .unwrap_or((skipped_files.len() as i64, String::new()));

    Ok(CachedScan {
        photos,
        skipped_files,
        skipped_count: meta.0.max(0) as usize,
        root_dir: meta.1,
    })
}

/// キャッシュを [`ScanResult`] として読み出す。行が無ければ空の結果になる。
fn read_all(conn: &Connection) -> Result<ScanResult, String> {
    let cached = read_snapshot(conn)?;
    let photos = cached.photos.into_iter().map(|entry| entry.photo).collect();
    Ok(ScanResult {
        photos,
        skipped_count: cached.skipped_count,
        root_dir: cached.root_dir,
        skipped_files: cached.skipped_files,
    })
}

/// 既存行の送信状態を、引き継ぎ判定に使えるようまとめて読む。
fn read_states(conn: &Connection) -> HashMap<String, CachedState> {
    let mut states = HashMap::new();
    let Ok(cached) = read_snapshot(conn) else {
        return states;
    };
    for entry in cached.photos {
        states.insert(
            entry.photo.path,
            CachedState {
                stamp: FileStamp {
                    mtime_millis: entry.mtime_millis,
                    size: entry.size,
                },
                sha256: entry.photo.sha256,
                uploaded: entry.photo.uploaded,
            },
        );
    }
    states
}

/// キャッシュを走査側へ渡す。読み出せない場合は呼び出し側で全走査へ戻す。
pub(crate) fn read_cached_scan(app: &AppHandle) -> Result<CachedScan, String> {
    open_cache(app).and_then(|conn| read_snapshot(&conn))
}

/// 走査結果でキャッシュを全置換する。今回の走査に無いパスの行は消える。
///
/// 走査で得た [`Photo`] は sha256 が未計算・uploaded が false で固定なので、
/// そのまま入れ直すと送信済みバッジが毎回消えてしまう。ファイルが変わっていない
/// （mtime と size が一致する）行に限り、前回の sha256 / uploaded を引き継ぐ。
fn replace_all(conn: &mut Connection, result: &ScanResult) -> Result<(), String> {
    let previous = read_states(conn);
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    {
        // 消えた写真と除外ファイルの行を残さないよう、丸ごと消してから入れ直す。
        // パスを列挙して消すやり方はプレースホルダ数の上限に当たりうるので避ける。
        tx.execute("DELETE FROM scan_cache", [])
            .map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM scan_skipped", [])
            .map_err(|e| e.to_string())?;
        let mut stmt = tx
            .prepare(
                "INSERT INTO scan_cache (path, mtime, size, photo, sha256, uploaded)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            )
            .map_err(|e| e.to_string())?;
        for photo in &result.photos {
            let json = serde_json::to_string(photo).map_err(|e| e.to_string())?;
            // 指紋が取れないファイルは引き継ぎ対象外にしたいので、一致しない値を入れておく。
            let stamp = file_stamp(Path::new(&photo.path)).unwrap_or(FileStamp {
                mtime_millis: -1,
                size: 0,
            });
            let carried = previous
                .get(&photo.path)
                .filter(|state| state.stamp == stamp);
            stmt.execute(rusqlite::params![
                photo.path,
                stamp.mtime_millis,
                stamp.size as i64,
                json,
                carried.and_then(|state| state.sha256.clone()),
                carried.is_some_and(|state| state.uploaded) as i64,
            ])
            .map_err(|e| e.to_string())?;
        }
        drop(stmt);
        let mut skipped_stmt = tx
            .prepare("INSERT INTO scan_skipped (path, mtime, size) VALUES (?1, ?2, ?3)")
            .map_err(|e| e.to_string())?;
        for skipped in &result.skipped_files {
            skipped_stmt
                .execute(rusqlite::params![
                    skipped.path,
                    skipped.mtime_millis,
                    skipped.size as i64
                ])
                .map_err(|e| e.to_string())?;
        }
        drop(skipped_stmt);
        tx.execute(
            "INSERT INTO scan_meta (id, skipped_count, root_dir) VALUES (1, ?1, ?2)
             ON CONFLICT(id) DO UPDATE SET skipped_count = ?1, root_dir = ?2",
            rusqlite::params![result.skipped_count as i64, result.root_dir],
        )
        .map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())
}

/// 送信状態だけを更新する。
///
/// 写真の JSON 側は触らない。読み出しで列の値を必ず上書きしているため、
/// ここで JSON を書き直しても結果は変わらない（列が正、という取り決め）。
/// まだ走査されていないパスは行が無く、mtime / size を作れないので何もしない。
///
/// 呼び出しは月ごとの送信済み判定 1 回分（数千行になりうる）なので、
/// replace_all と同じくトランザクションで囲む。囲まないと 1 行ごとに
/// コミットが走り、判定が終わるたびに体感できるほど待たされる。
fn update_upload_state(conn: &mut Connection, entries: &[UploadStateEntry]) -> Result<(), String> {
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    {
        let mut stmt = tx
            .prepare("UPDATE scan_cache SET sha256 = ?2, uploaded = ?3 WHERE path = ?1")
            .map_err(|e| e.to_string())?;
        for entry in entries {
            stmt.execute(rusqlite::params![
                entry.path,
                entry.sha256,
                entry.uploaded as i64
            ])
            .map_err(|e| e.to_string())?;
        }
    }
    tx.commit().map_err(|e| e.to_string())
}

/// 走査結果をキャッシュへ書き戻す。失敗しても走査そのものは成功させたいので警告に留める。
pub fn store_scan_result(app: &AppHandle, result: &ScanResult) {
    let stored = open_cache(app).and_then(|mut conn| replace_all(&mut conn, result));
    if let Err(e) = stored {
        eprintln!("warning: could not update the scan cache: {e}");
    }
}

/// 前回の走査結果をそのまま返す。起動直後に一覧を出すための入口。
///
/// キャッシュがまだ無い・読めない場合も空の結果を返す。ここで Err にすると
/// 表示の速さのためだけの仕組みが、起動のたびのエラー表示になってしまう。
#[tauri::command]
pub async fn cached_photos(app: AppHandle) -> Result<ScanResult, String> {
    let empty = || ScanResult {
        photos: Vec::new(),
        skipped_count: 0,
        root_dir: String::new(),
        skipped_files: Vec::new(),
    };
    // SQLite の読み出しはブロッキングなのでプールへ逃がす。
    tauri::async_runtime::spawn_blocking(move || {
        match open_cache(&app).and_then(|c| read_all(&c)) {
            Ok(result) => result,
            Err(e) => {
                eprintln!("warning: could not read the scan cache: {e}");
                empty()
            }
        }
    })
    .await
    .map_err(|e| e.to_string())
}

/// 送信済み判定の結果をキャッシュへ反映する。
#[tauri::command]
pub async fn update_scan_cache_upload_state(
    app: AppHandle,
    entries: Vec<UploadStateEntry>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut conn = open_cache(&app)?;
        update_upload_state(&mut conn, &entries)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// キャッシュを空にする。表示がおかしくなったときの逃げ道。
#[tauri::command]
pub async fn clear_scan_cache(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = open_cache(&app)?;
        conn.execute("DELETE FROM scan_cache", [])
            .map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM scan_skipped", [])
            .map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM scan_meta", [])
            .map_err(|e| e.to_string())?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::metadata::{PlayerRef, VrcxMetadata, WorldRef};

    /// テスト用の写真を 1 枚作る。実ファイルを指すパスを渡すと指紋も付く。
    fn sample_photo(path: &str, taken_at: i64) -> Photo {
        Photo {
            path: path.to_string(),
            file_name: "VRChat_2026-05-27_03-31-44.098_1920x1080.png".to_string(),
            taken_at,
            month: "2026-05".to_string(),
            width: 1920,
            height: 1080,
            byte_size: 4,
            metadata: VrcxMetadata {
                application: "VRCX".to_string(),
                version: 1,
                author: PlayerRef {
                    id: "usr_1".to_string(),
                    display_name: "author".to_string(),
                },
                world: WorldRef {
                    id: "wrld_1".to_string(),
                    name: "world".to_string(),
                    instance_id: "1".to_string(),
                },
                players: Vec::new(),
            },
            sha256: None,
            uploaded: false,
        }
    }

    fn in_memory() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        init_schema(&conn).unwrap();
        conn
    }

    #[test]
    fn stored_photos_can_be_read_back() {
        let mut conn = in_memory();
        // 保存順に依存していないことを見るため、古い写真から先に入れる。
        let result = ScanResult {
            photos: vec![sample_photo("/b.png", 100), sample_photo("/a.png", 200)],
            skipped_count: 3,
            root_dir: "/root".to_string(),
            skipped_files: Vec::new(),
        };
        replace_all(&mut conn, &result).unwrap();

        let restored = read_all(&conn).unwrap();
        assert_eq!(restored.photos.len(), 2);
        // 走査結果と同じく、新しい写真が先頭に来ること。
        assert_eq!(restored.photos[0].path, "/a.png");
        assert_eq!(restored.skipped_count, 3);
        assert_eq!(restored.root_dir, "/root");
    }

    #[test]
    fn paths_missing_from_the_new_scan_are_dropped() {
        let mut conn = in_memory();
        let first = ScanResult {
            photos: vec![sample_photo("/a.png", 200), sample_photo("/b.png", 100)],
            skipped_count: 0,
            root_dir: "/root".to_string(),
            skipped_files: Vec::new(),
        };
        replace_all(&mut conn, &first).unwrap();

        let second = ScanResult {
            photos: vec![sample_photo("/a.png", 200)],
            skipped_count: 0,
            root_dir: "/root".to_string(),
            skipped_files: Vec::new(),
        };
        replace_all(&mut conn, &second).unwrap();

        let restored = read_all(&conn).unwrap();
        assert_eq!(restored.photos.len(), 1);
        assert_eq!(restored.photos[0].path, "/a.png");
    }

    #[test]
    fn upload_state_survives_a_rescan_of_an_unchanged_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.png");
        std::fs::write(&path, b"data").unwrap();
        let key = path.to_string_lossy().into_owned();

        let mut conn = in_memory();
        let result = ScanResult {
            photos: vec![sample_photo(&key, 100)],
            skipped_count: 0,
            root_dir: "/root".to_string(),
            skipped_files: Vec::new(),
        };
        replace_all(&mut conn, &result).unwrap();
        update_upload_state(
            &mut conn,
            &[UploadStateEntry {
                path: key.clone(),
                sha256: Some("abc".to_string()),
                uploaded: true,
            }],
        )
        .unwrap();

        // ファイルが変わっていなければ、走査し直しても送信済みのままであること。
        replace_all(&mut conn, &result).unwrap();
        let restored = read_all(&conn).unwrap();
        assert_eq!(restored.photos[0].sha256.as_deref(), Some("abc"));
        assert!(restored.photos[0].uploaded);
    }
    #[test]
    fn skipped_file_manifest_survives_a_cache_round_trip() {
        let mut conn = in_memory();
        let result = ScanResult {
            photos: Vec::new(),
            skipped_count: 1,
            root_dir: "/root".to_string(),
            skipped_files: vec![SkippedFile {
                path: "/unrelated.png".to_string(),
                mtime_millis: 123,
                size: 456,
            }],
        };
        replace_all(&mut conn, &result).unwrap();

        let restored = read_snapshot(&conn).unwrap();
        assert_eq!(restored.skipped_count, 1);
        assert_eq!(restored.skipped_files.len(), 1);
        assert_eq!(restored.skipped_files[0].path, "/unrelated.png");
        assert_eq!(restored.skipped_files[0].mtime_millis, 123);
        assert_eq!(restored.skipped_files[0].size, 456);
    }
}
