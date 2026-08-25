//! スクリーンショットの走査。
//!
//! 保存先を再帰的に辿って PNG を集め、VRCX メタデータを持つものだけを [`Photo`] にする。
//! メタデータが無い写真はワールドも同席者も分からないため、件数だけ数えて除外する。

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::UNIX_EPOCH;

use chrono::{Local, TimeZone};
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use walkdir::WalkDir;

use crate::metadata::{parse_png_meta, PngParseError, VrcxMetadata};
use crate::settings::load_settings;

/// メタデータ抽出のために最初に読むバイト数。
/// VRCX のテキストチャンクは IDAT より前にあるので、通常はこれで足りる。
const HEADER_PREFIX_BYTES: usize = 512 * 1024;

/// 進捗イベントを何件ごとに送るか。細かすぎると IPC が詰まる。
const PROGRESS_INTERVAL: usize = 25;

/// 走査の進捗イベント名。
pub const SCAN_PROGRESS_EVENT: &str = "scan_progress";

/// ローカルにあるスクリーンショット1枚。`packages/core/src/photo.ts` の `Photo` に対応する。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Photo {
    /// 絶対パス。ローカルでの一意キー。
    pub path: String,
    pub file_name: String,
    /// 撮影日時（unix ミリ秒、ローカル時刻から復元）。
    pub taken_at: i64,
    /// `YYYY-MM` 形式の月バケット。
    pub month: String,
    pub width: u32,
    pub height: u32,
    pub byte_size: u64,
    pub metadata: VrcxMetadata,
    /// 元 PNG の SHA-256。走査時点では未計算なので null を返す。
    pub sha256: Option<String>,
    /// サーバーに送信済みか。未確認の間は false。
    pub uploaded: bool,
}

/// `scan_photos` の戻り値。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanResult {
    pub photos: Vec<Photo>,
    /// メタデータが無く一覧から除外した件数。
    pub skipped_count: usize,
    /// 実際に走査したディレクトリ。
    pub root_dir: String,
    /// キャッシュへ保存する除外ファイルの指紋。IPC には出さない。
    #[serde(skip)]
    pub(crate) skipped_files: Vec<SkippedFile>,
}

/// メタデータが無く一覧から除外した PNG の指紋。
#[derive(Debug, Clone)]
pub(crate) struct SkippedFile {
    pub(crate) path: String,
    pub(crate) mtime_millis: i64,
    pub(crate) size: u64,
}

/// 走査結果のキャッシュから復元した写真の指紋。
#[derive(Debug, Clone)]
pub(crate) struct CachedPhoto {
    pub(crate) photo: Photo,
    pub(crate) mtime_millis: i64,
    pub(crate) size: u64,
}

/// キャッシュ済みの一覧と、除外ファイルのマニフェスト。
#[derive(Debug, Clone)]
pub(crate) struct CachedScan {
    pub(crate) photos: Vec<CachedPhoto>,
    pub(crate) skipped_files: Vec<SkippedFile>,
    pub(crate) skipped_count: usize,
    pub(crate) root_dir: String,
}

/// 走査の進捗。フロントエンドは処理済み件数と総数でバーを描く。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanProgress {
    pub processed: usize,
    pub total: usize,
    pub current_path: String,
}

/// ファイル名から取り出せた撮影情報。取れなかった項目は None。
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ParsedFileName {
    pub taken_at: Option<i64>,
    pub width: Option<u32>,
    pub height: Option<u32>,
}

/// VRChat のファイル名から撮影日時と解像度を取り出す。
///
/// 例: `VRChat_2026-05-27_03-31-44.098_1920x1080.png`
/// 命名規則から外れたファイルもあるため、取れなかった項目は None を返す。
/// `packages/core` の `parseVrchatFileName` と同じ解釈（時刻はローカルタイム）にする。
pub fn parse_vrchat_file_name(file_name: &str) -> ParsedFileName {
    let none = ParsedFileName::default();
    let Some(rest) = file_name.strip_prefix("VRChat_") else {
        return none;
    };
    // `YYYY-MM-DD_HH-MM-SS.mmm` は固定長 23 文字。
    if rest.len() < 23 {
        return none;
    }
    let (stamp, tail) = rest.split_at(23);
    let bytes = stamp.as_bytes();
    // 区切り文字の位置が規則通りかを確認する。
    let separators_ok = bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes[10] == b'_'
        && bytes[13] == b'-'
        && bytes[16] == b'-'
        && bytes[19] == b'.';
    if !separators_ok {
        return none;
    }
    let num = |range: std::ops::Range<usize>| stamp[range].parse::<u32>().ok();
    let (Some(year), Some(month), Some(day), Some(hour), Some(min), Some(sec), Some(milli)) = (
        num(0..4),
        num(5..7),
        num(8..10),
        num(11..13),
        num(14..16),
        num(17..19),
        num(20..23),
    ) else {
        return none;
    };

    let taken_at = Local
        .with_ymd_and_hms(year as i32, month, day, hour, min, sec)
        .single()
        // 夏時間の折り返しなどで一意に決まらない時刻は諦める。
        .map(|dt| dt.timestamp_millis() + milli as i64);

    // 解像度部分 `_1920x1080` は省略されることがある。
    let (width, height) = parse_resolution(tail);
    ParsedFileName {
        taken_at,
        width,
        height,
    }
}

/// ファイル名末尾の `_WxH` を読む。無ければ (None, None)。
fn parse_resolution(tail: &str) -> (Option<u32>, Option<u32>) {
    let Some(rest) = tail.strip_prefix('_') else {
        return (None, None);
    };
    // `1920x1080.png` のように拡張子が続くため、数字と `x` の並びだけを見る。
    let digits_and_x: String = rest
        .chars()
        .take_while(|c| c.is_ascii_digit() || *c == 'x')
        .collect();
    let Some((w, h)) = digits_and_x.split_once('x') else {
        return (None, None);
    };
    match (w.parse::<u32>(), h.parse::<u32>()) {
        (Ok(w), Ok(h)) if w > 0 && h > 0 => (Some(w), Some(h)),
        _ => (None, None),
    }
}

/// unix ミリ秒から `YYYY-MM` のバケット名を作る（ローカル時刻基準）。
pub fn to_month_key(taken_at: i64) -> String {
    Local
        .timestamp_millis_opt(taken_at)
        .single()
        .map(|dt| dt.format("%Y-%m").to_string())
        .unwrap_or_else(|| "unknown".to_string())
}

/// 走査対象のルートディレクトリを決める。
/// 設定が空なら OS の Pictures + `VRChat` を使う。
pub fn resolve_root_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let settings = load_settings(app)?;
    if !settings.screenshot_dir.trim().is_empty() {
        return Ok(PathBuf::from(settings.screenshot_dir));
    }
    let pictures = app
        .path()
        .picture_dir()
        .map_err(|e| format!("could not resolve the pictures directory: {e}"))?;
    Ok(pictures.join("VRChat"))
}

/// 現在の保存先を asset プロトコルのスコープに追加する。
///
/// 保存先は設定でユーザーが自由に変えられ、Windows では任意のドライブの
/// 任意パスになりうる。`tauri.conf.json` の静的な glob だけでは網羅できないため、
/// 実行時に解決したディレクトリだけを都度許可する（全体開放はしない）。
/// 起動時と設定更新後に呼ぶこと。
pub fn allow_root_dir_asset_scope(app: &AppHandle) -> Result<(), String> {
    let root = resolve_root_dir(app)?;
    // canonicalize すると Windows で `\\?\C:\...` になり、
    // WebView から来る `C:\...` 形式のパスと一致しなくなるのでそのまま渡す。
    app.asset_protocol_scope()
        // サブフォルダ（`YYYY-MM` など）配下も読めるよう再帰的に許可する。
        .allow_directory(&root, true)
        .map_err(|e| {
            format!(
                "could not allow the asset scope for {}: {e}",
                root.display()
            )
        })
}

/// 取得済みのファイル属性を使って 1 ファイルを [`Photo`] に変換する。
fn build_photo_with_file_meta(path: &Path, file_meta: &std::fs::Metadata) -> Option<Photo> {
    let byte_size = file_meta.len();

    // まず先頭だけ読む。テキストチャンクが後ろにある稀なケースだけ全体を読み直す。
    let png_meta = match read_png_meta(path, HEADER_PREFIX_BYTES) {
        Ok(meta) => meta,
        Err(PngParseError::Truncated) => read_png_meta(path, usize::MAX).ok()?,
        Err(_) => return None,
    };
    let metadata = png_meta.vrcx?;

    let file_name = path.file_name()?.to_string_lossy().into_owned();
    let parsed = parse_vrchat_file_name(&file_name);

    // 撮影日時はファイル名優先、駄目なら mtime。
    let taken_at = parsed.taken_at.or_else(|| mtime_millis(file_meta))?;
    // 解像度もファイル名優先で、無ければ IHDR の値を使う。
    let width = parsed.width.unwrap_or(png_meta.width);
    let height = parsed.height.unwrap_or(png_meta.height);

    Some(Photo {
        path: path.to_string_lossy().into_owned(),
        file_name,
        taken_at,
        // 月は必ず最終的な taken_at から導く。mtime にフォールバックした場合も整合させるため。
        month: to_month_key(taken_at),
        width,
        height,
        byte_size,
        metadata,
        sha256: None,
        uploaded: false,
    })
}

/// ファイル属性からキャッシュ比較用の指紋を作る。
fn file_stamp(file_meta: &std::fs::Metadata) -> Option<(i64, u64)> {
    Some((mtime_millis(file_meta)?, file_meta.len()))
}

/// ファイル更新時刻を unix ミリ秒で返す。
fn mtime_millis(file_meta: &std::fs::Metadata) -> Option<i64> {
    let modified = file_meta.modified().ok()?;
    let duration = modified.duration_since(UNIX_EPOCH).ok()?;
    Some(duration.as_millis() as i64)
}

/// 先頭 `limit` バイトだけを読んで PNG ヘッダを解析する。
fn read_png_meta(path: &Path, limit: usize) -> Result<crate::metadata::PngMeta, PngParseError> {
    use std::io::Read;
    let mut file = std::fs::File::open(path).map_err(|_| PngParseError::NotPng)?;
    let mut buffer = Vec::new();
    if limit == usize::MAX {
        file.read_to_end(&mut buffer)
            .map_err(|_| PngParseError::NotPng)?;
    } else {
        file.take(limit as u64)
            .read_to_end(&mut buffer)
            .map_err(|_| PngParseError::NotPng)?;
    }
    parse_png_meta(&buffer)
}

/// ルート配下の PNG を列挙する。シンボリックリンクは辿らない。
fn collect_png_paths(root: &Path) -> Vec<PathBuf> {
    WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_file())
        .map(|entry| entry.into_path())
        .filter(|path| {
            path.extension()
                .is_some_and(|ext| ext.eq_ignore_ascii_case("png"))
        })
        .collect()
}

/// ルート配下を走査して [`ScanResult`] を組み立てる。進捗は `emit` 経由で通知する。
pub fn scan_directory(root: &Path, emit: impl Fn(ScanProgress) + Sync + Send) -> ScanResult {
    scan_directory_with_cache(root, None, emit)
}

/// キャッシュを利用してルート配下を差分走査する。
///
/// 当月・前月は編集や追加を確実に拾うため毎回 PNG を解析する。
/// それより古い月は `(mtime, size)` が一致するキャッシュ行を再利用し、
/// 過去写真のメタデータ読み込みを省く。
fn scan_directory_with_cache(
    root: &Path,
    cache: Option<&CachedScan>,
    emit: impl Fn(ScanProgress) + Sync + Send,
) -> ScanResult {
    let paths = collect_png_paths(root);
    let total = paths.len();
    let processed = AtomicUsize::new(0);
    let recent_months = recent_months();
    let cached_photos = cache
        .map(|value| {
            value
                .photos
                .iter()
                .map(|entry| (entry.photo.path.as_str(), entry))
                .collect::<std::collections::HashMap<_, _>>()
        })
        .unwrap_or_default();
    let cached_skipped = cache
        .map(|value| {
            value
                .skipped_files
                .iter()
                .map(|entry| (entry.path.as_str(), entry))
                .collect::<std::collections::HashMap<_, _>>()
        })
        .unwrap_or_default();

    let scanned: Vec<(Option<Photo>, Option<SkippedFile>)> = paths
        .par_iter()
        .map(|path| {
            let file_meta = std::fs::metadata(path).ok();
            let stamp = file_meta.as_ref().and_then(file_stamp);
            let path_key = path.to_string_lossy();
            let cached_photo = cached_photos.get(path_key.as_ref()).copied();
            let cached_skipped = cached_skipped.get(path_key.as_ref()).copied();
            let photo_is_recent = cached_photo.is_some_and(|entry| {
                recent_months
                    .iter()
                    .any(|month| month == &entry.photo.month)
            });
            let skipped_is_recent =
                cached_skipped.is_some() && is_recent_path(path, stamp, &recent_months);
            let same_photo_stamp = cached_photo.is_some_and(|entry| {
                stamp.is_some_and(|(mtime, size)| entry.mtime_millis == mtime && entry.size == size)
            });
            let same_skipped_stamp = cached_skipped.is_some_and(|entry| {
                stamp.is_some_and(|(mtime, size)| entry.mtime_millis == mtime && entry.size == size)
            });

            let result = if let Some(entry) =
                cached_photo.filter(|_| !photo_is_recent && same_photo_stamp)
            {
                (Some(entry.photo.clone()), None)
            } else if let Some(entry) =
                cached_skipped.filter(|_| !skipped_is_recent && same_skipped_stamp)
            {
                (
                    None,
                    Some(SkippedFile {
                        path: entry.path.clone(),
                        mtime_millis: entry.mtime_millis,
                        size: entry.size,
                    }),
                )
            } else {
                match file_meta
                    .as_ref()
                    .and_then(|meta| build_photo_with_file_meta(path, meta))
                {
                    Some(photo) => (Some(photo), None),
                    None => (None, Some(skipped_file(path, stamp))),
                }
            };

            let done = processed.fetch_add(1, Ordering::Relaxed) + 1;
            // 一定間隔と最後の1件だけ通知して、IPC の負荷を抑える。
            if done % PROGRESS_INTERVAL == 0 || done == total {
                emit(ScanProgress {
                    processed: done,
                    total,
                    current_path: path.to_string_lossy().into_owned(),
                });
            }
            result
        })
        .collect();

    let mut photos = Vec::with_capacity(scanned.len());
    let mut skipped_files = Vec::new();
    for (photo, skipped) in scanned {
        if let Some(photo) = photo {
            photos.push(photo);
        }
        if let Some(skipped) = skipped {
            skipped_files.push(skipped);
        }
    }
    // 新しい写真を先頭に。フロントエンドでの並べ替えを省くため。
    photos.sort_by(|a, b| b.taken_at.cmp(&a.taken_at));

    ScanResult {
        skipped_count: skipped_files.len(),
        photos,
        root_dir: root.to_string_lossy().into_owned(),
        skipped_files,
    }
}

/// 当月と前月の月キーを返す。
fn recent_months() -> [String; 2] {
    use chrono::Datelike;
    let now = Local::now();
    let (year, month) = (now.year(), now.month());
    let (previous_year, previous_month) = if month == 1 {
        (year - 1, 12)
    } else {
        (year, month - 1)
    };
    [
        format!("{year:04}-{month:02}"),
        format!("{previous_year:04}-{previous_month:02}"),
    ]
}

/// キャッシュ済み除外ファイルが当月・前月に属するかを判定する。
fn is_recent_path(path: &Path, stamp: Option<(i64, u64)>, months: &[String; 2]) -> bool {
    let file_name = path.file_name().and_then(|name| name.to_str());
    let month = file_name
        .and_then(|name| parse_vrchat_file_name(name).taken_at)
        .or_else(|| stamp.map(|(mtime, _)| mtime))
        .map(to_month_key);
    month.is_none_or(|month| months.iter().any(|recent| recent == &month))
}

/// 走査から除外したファイルをキャッシュへ保存できる形にする。
fn skipped_file(path: &Path, stamp: Option<(i64, u64)>) -> SkippedFile {
    let (mtime_millis, size) = stamp.unwrap_or((-1, 0));
    SkippedFile {
        path: path.to_string_lossy().into_owned(),
        mtime_millis,
        size,
    }
}

/// スクリーンショットを走査して、メタデータ付きの写真一覧を返す。
#[tauri::command]
pub async fn scan_photos(app: AppHandle) -> Result<ScanResult, String> {
    let root = resolve_root_dir(&app)?;
    // ここで返すパスがそのまま <img> の src になるため、走査のたびに
    // asset スコープを合わせておく（設定の書かれ方によらず取りこぼさない）。
    if let Err(e) = allow_root_dir_asset_scope(&app) {
        eprintln!("warning: {e}");
    }
    if !root.is_dir() {
        return Err(format!(
            "screenshot directory was not found: {}",
            root.display()
        ));
    }

    // 走査は CPU / I/O ともに重いのでブロッキングプールへ逃がす。
    let handle = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let cached = crate::scan_cache::read_cached_scan(&handle)
            .ok()
            .filter(|value| value.root_dir == root.to_string_lossy());
        let result = scan_directory_with_cache(&root, cached.as_ref(), |progress| {
            let _ = handle.emit(SCAN_PROGRESS_EVENT, progress);
        });
        // 次の起動で即座に一覧を出せるよう、結果をキャッシュへ残す。
        // 書き込みに失敗しても走査結果自体は返せるので、警告だけにする。
        crate::scan_cache::store_scan_result(&handle, &result);
        result
    })
    .await
    .map_err(|e| e.to_string())?;
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::metadata::{PlayerRef, VrcxMetadata, WorldRef};

    #[test]
    fn parses_timestamp_and_resolution_from_file_name() {
        let parsed = parse_vrchat_file_name("VRChat_2026-05-27_03-31-44.098_1920x1080.png");
        assert_eq!(parsed.width, Some(1920));
        assert_eq!(parsed.height, Some(1080));
        let expected = Local
            .with_ymd_and_hms(2026, 5, 27, 3, 31, 44)
            .unwrap()
            .timestamp_millis()
            + 98;
        assert_eq!(parsed.taken_at, Some(expected));
    }

    #[test]
    fn resolution_is_optional_in_file_name() {
        let parsed = parse_vrchat_file_name("VRChat_2026-05-27_03-31-44.098.png");
        assert!(parsed.taken_at.is_some());
        assert_eq!(parsed.width, None);
    }

    #[test]
    fn unrelated_file_name_yields_nothing() {
        assert_eq!(
            parse_vrchat_file_name("screenshot.png"),
            ParsedFileName::default()
        );
    }

    #[test]
    fn month_bucket_matches_the_file_name_month() {
        let parsed = parse_vrchat_file_name("VRChat_2025-12-31_23-59-59.999_1920x1080.png");
        assert_eq!(to_month_key(parsed.taken_at.unwrap()), "2025-12");
    }

    /// リポジトリ同梱のサンプル（.vrc/VRChat）に対する実走査。
    /// 枚数が多く時間がかかるため既定では実行しない（`cargo test -- --ignored`）。
    #[test]
    #[ignore]
    fn scans_the_bundled_sample_directory() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../.vrc/VRChat")
            .canonicalize();
        let Ok(root) = root else {
            eprintln!("sample directory is not available; skipping");
            return;
        };
        let result = scan_directory(&root, |_| {});
        eprintln!(
            "photos={} skipped={} months={:?}",
            result.photos.len(),
            result.skipped_count,
            result
                .photos
                .iter()
                .map(|p| p.month.clone())
                .collect::<std::collections::BTreeSet<_>>()
        );
        assert!(!result.photos.is_empty());
        // 走査できた写真は必ず VRCX のメタデータを持つ。
        // ワールド名はワールド取得前に撮った場合など空になり得るので条件にしない。
        assert!(result
            .photos
            .iter()
            .all(|p| !p.metadata.application.is_empty()));
        assert!(result.photos.iter().all(|p| p.width > 0 && p.height > 0));
    }

    #[test]
    fn month_bucket_is_derived_from_taken_at_even_without_a_file_name_match() {
        // mtime へフォールバックした場合でも月バケットは takenAt から決まる。
        let taken_at = Local
            .with_ymd_and_hms(2024, 1, 2, 12, 0, 0)
            .unwrap()
            .timestamp_millis();
        assert_eq!(to_month_key(taken_at), "2024-01");
    }
    #[test]
    fn unchanged_old_photo_is_reused_without_reading_its_png() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("old.png");
        // PNG として壊れているため、再解析されれば一覧から除外される。
        std::fs::write(&path, b"not a png").unwrap();
        let meta = std::fs::metadata(&path).unwrap();
        let (mtime_millis, size) = file_stamp(&meta).unwrap();
        let path_text = path.to_string_lossy().into_owned();
        let cache = CachedScan {
            photos: vec![CachedPhoto {
                photo: Photo {
                    path: path_text,
                    file_name: "old.png".to_string(),
                    taken_at: 946_684_800_000,
                    month: "2000-01".to_string(),
                    width: 1,
                    height: 1,
                    byte_size: size,
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
                },
                mtime_millis,
                size,
            }],
            skipped_files: Vec::new(),
            skipped_count: 0,
            root_dir: dir.path().to_string_lossy().into_owned(),
        };

        let result = scan_directory_with_cache(dir.path(), Some(&cache), |_| {});
        assert_eq!(result.photos.len(), 1);
        assert_eq!(result.photos[0].path, cache.photos[0].photo.path);
        assert_eq!(result.skipped_count, 0);
    }
}
