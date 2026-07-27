//! 一覧表示用サムネイルのローカルキャッシュ。
//!
//! VRChat のスクリーンショットは 4K・数 MB の PNG で、そのまま `<img>` に渡すと
//! WebView が原寸をデコードするため、176px のセルを並べるだけで数秒固まる。
//! そこで一度だけ縮小した JPEG をアプリのキャッシュディレクトリに書き出し、
//! 一覧はそちらを読む。
//!
//! JPEG にしているのは、この画像が WebView に渡るだけで外には出ないため。
//! AVIF はエンコードが桁違いに遅く、初回生成そのものが待ち時間になってしまう。

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use image::codecs::jpeg::JpegEncoder;
use image::imageops::FilterType;
use rayon::prelude::*;
use serde::Serialize;
use tauri::{AppHandle, Manager};

/// サムネイルの長辺（px）。グリッドのセルは 176px 前後なので、
/// 高 DPI 表示でも粗くならない程度に余裕を持たせる。
const THUMBNAIL_LONG_EDGE: u32 = 384;

/// JPEG の品質。一覧で見る用途ではこれ以上上げても差が分からない。
const JPEG_QUALITY: u8 = 80;

/// キャッシュを置くサブディレクトリ名。
const CACHE_SUBDIR: &str = "thumbnails";

/// 1枚分のサムネイル。フロントエンドはこのパスを asset URL に変換して表示する。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThumbnailEntry {
    /// 元のスクリーンショットの絶対パス。一覧のキーと同じ値。
    pub path: String,
    /// 生成済みサムネイルの絶対パス。
    pub thumbnail_path: String,
}

/// キャッシュディレクトリを返す（無ければ作る）。
fn cache_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("could not resolve the cache directory: {e}"))?
        .join(CACHE_SUBDIR);
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("could not create {}: {e}", dir.display()))?;
    Ok(dir)
}

/// キャッシュディレクトリを asset プロトコルのスコープに入れる。
///
/// スコープに無いパスは実行時に 403 になり、ビルドでは気付けない。
/// 起動時に一度だけ呼ぶこと。
pub fn allow_cache_dir_asset_scope(app: &AppHandle) -> Result<(), String> {
    let dir = cache_dir(app)?;
    app.asset_protocol_scope()
        .allow_directory(&dir, true)
        .map_err(|e| format!("could not allow the asset scope for {}: {e}", dir.display()))
}

/// キャッシュファイル名を決める。
///
/// 内容ハッシュ（sha256）は元の 4K PNG を丸ごと読む必要があり、
/// まさに避けたいコストなので使わない。パス・更新時刻・サイズで十分に区別できる。
fn cache_key(path: &Path) -> Result<String, String> {
    let meta = std::fs::metadata(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis())
        .unwrap_or(0);

    let mut hasher = DefaultHasher::new();
    path.to_string_lossy().hash(&mut hasher);
    mtime.hash(&mut hasher);
    meta.len().hash(&mut hasher);
    // 生成条件が変わったら作り直せるよう、寸法と品質もキーに混ぜる。
    THUMBNAIL_LONG_EDGE.hash(&mut hasher);
    JPEG_QUALITY.hash(&mut hasher);
    Ok(format!("{:016x}.jpg", hasher.finish()))
}

/// 1枚を縮小して JPEG として書き出す。既にあれば何もしない。
fn build_one(source: &Path, destination: &Path) -> Result<(), String> {
    if destination.exists() {
        return Ok(());
    }

    let decoded = image::open(source).map_err(|e| format!("{}: {e}", source.display()))?;
    let (width, height) = (decoded.width(), decoded.height());
    let current = width.max(height);
    // 既に十分小さければ縮小せずそのまま使う。
    let resized = if current > THUMBNAIL_LONG_EDGE {
        let ratio = THUMBNAIL_LONG_EDGE as f64 / current as f64;
        let scale = |value: u32| ((value as f64 * ratio).round() as u32).max(1);
        // Triangle は Lanczos3 より速く、この縮小率では見た目の差が出ない。
        decoded.resize(scale(width), scale(height), FilterType::Triangle)
    } else {
        decoded
    };
    let rgb = resized.to_rgb8();

    // 途中で落ちた半端なファイルを次回そのまま使わないよう、一時名で書いてから差し替える。
    let temp = destination.with_extension("jpg.tmp");
    let mut buffer = Vec::new();
    JpegEncoder::new_with_quality(&mut buffer, JPEG_QUALITY)
        .encode_image(&rgb)
        .map_err(|e| format!("JPEG encoding failed: {e}"))?;
    std::fs::write(&temp, &buffer).map_err(|e| format!("{}: {e}", temp.display()))?;
    std::fs::rename(&temp, destination).map_err(|e| format!("{}: {e}", destination.display()))?;
    Ok(())
}

/// 指定した写真のサムネイルを用意してパスを返す。
///
/// 画面に映っている分だけを渡すこと。ライブラリ全体を一度に渡すと、
/// 結局まとめて待つことになり、遅さの置き場所が変わるだけになる。
/// 生成に失敗した写真は結果から落ちるだけで、他の写真の表示は妨げない。
#[tauri::command]
pub async fn thumbnail_paths(
    app: AppHandle,
    paths: Vec<String>,
) -> Result<Vec<ThumbnailEntry>, String> {
    let dir = cache_dir(&app)?;

    // デコードと縮小は CPU バウンドなのでブロッキングプールへ逃がす。
    tauri::async_runtime::spawn_blocking(move || {
        paths
            .par_iter()
            .filter_map(|path| {
                let source = PathBuf::from(path);
                let destination = dir.join(cache_key(&source).ok()?);
                match build_one(&source, &destination) {
                    Ok(()) => Some(ThumbnailEntry {
                        path: path.clone(),
                        thumbnail_path: destination.to_string_lossy().into_owned(),
                    }),
                    Err(e) => {
                        eprintln!("warning: thumbnail generation failed: {e}");
                        None
                    }
                }
            })
            .collect()
    })
    .await
    .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 生成条件が同じなら同じ名前、違うファイルなら違う名前になること。
    #[test]
    fn cache_key_is_stable_per_file() {
        let dir = std::env::temp_dir().join("dragonfly-thumb-test");
        std::fs::create_dir_all(&dir).unwrap();
        let a = dir.join("a.png");
        let b = dir.join("b.png");
        std::fs::write(&a, b"aaaa").unwrap();
        std::fs::write(&b, b"bbbbbb").unwrap();

        assert_eq!(cache_key(&a).unwrap(), cache_key(&a).unwrap());
        assert_ne!(cache_key(&a).unwrap(), cache_key(&b).unwrap());
    }
}
