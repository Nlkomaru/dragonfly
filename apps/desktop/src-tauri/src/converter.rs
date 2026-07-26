//! PNG から AVIF への変換。
//!
//! AVIF にはテキストチャンクが無いため、変換後に VRCX の JSON を XMP アイテムとして
//! `meta` ボックスへ埋め戻す（[`crate::avif_meta`]）。埋め込みに失敗しても
//! 画像自体は有効なので、その場合は元のバイト列をそのまま使う。

use std::path::Path;

use image::imageops::FilterType;
use serde::Serialize;

use crate::avif_meta::{build_xmp_packet, embed_xmp};

/// 変換の進捗イベント名。
pub const CONVERT_PROGRESS_EVENT: &str = "convert_progress";

/// サムネイルの長辺（px）。一覧表示に足りる大きさ。
const THUMBNAIL_LONG_EDGE: u32 = 512;

/// AVIF エンコードの速度（1 が最高画質、10 が最速）。枚数が多いので速度側に寄せる。
const ENCODE_SPEED: u8 = 6;
/// サムネイルは更に速度優先で良い。
const THUMBNAIL_SPEED: u8 = 10;

/// 1枚分の変換結果。
#[derive(Debug, Clone)]
pub struct ConvertedPhoto {
    /// 本体の AVIF バイト列。
    pub image: Vec<u8>,
    /// サムネイルの AVIF バイト列。
    pub thumbnail: Vec<u8>,
    /// 縮小後の解像度。サーバーへ送るメタデータに使う。
    pub width: u32,
    pub height: u32,
}

/// 変換の進捗。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConvertProgress {
    pub processed: usize,
    pub total: usize,
    pub current_path: String,
}

/// 長辺の上限に合わせた縮小後サイズを求める。既に収まっていれば None。
fn fit_long_edge(width: u32, height: u32, long_edge: u32) -> Option<(u32, u32)> {
    let current = width.max(height);
    if current <= long_edge || current == 0 {
        return None;
    }
    let ratio = long_edge as f64 / current as f64;
    let scaled = |value: u32| ((value as f64 * ratio).round() as u32).max(1);
    Some((scaled(width), scaled(height)))
}

/// RGBA8 のバッファを AVIF にエンコードする。
fn encode_avif(rgba: &image::RgbaImage, quality: u8, speed: u8) -> Result<Vec<u8>, String> {
    // ravif は RGBA8 のスライスを受け取る。image の生バッファと表現が同じなので詰め替えるだけ。
    let pixels: &[rgb::RGBA8] = as_rgba_slice(rgba.as_raw());
    let img = ravif::Img::new(pixels, rgba.width() as usize, rgba.height() as usize);
    let encoded = ravif::Encoder::new()
        .with_quality(quality as f32)
        .with_speed(speed)
        .encode_rgba(img)
        .map_err(|e| format!("AVIF encoding failed: {e}"))?;
    Ok(encoded.avif_file)
}

/// `[u8]` を `[RGBA8]` として読み替える。どちらも 1 バイト境界の POD なので安全に変換できる。
fn as_rgba_slice(bytes: &[u8]) -> &[rgb::RGBA8] {
    // SAFETY: RGBA8 は #[repr(C)] な u8 4つで、アラインメントは 1。長さは 4 の倍数。
    unsafe { std::slice::from_raw_parts(bytes.as_ptr() as *const rgb::RGBA8, bytes.len() / 4) }
}

/// PNG を AVIF（本体 + サムネイル）へ変換する。
///
/// `vrcx_json` を渡すと、変換後の AVIF に XMP として同じ JSON を埋め込む。
pub fn convert_png(
    path: &Path,
    quality: u8,
    max_long_edge: Option<u32>,
    vrcx_json: Option<&str>,
) -> Result<ConvertedPhoto, String> {
    let decoded = image::open(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let mut rgba = decoded.to_rgba8();

    // 設定された長辺上限を超えていれば縮小する。
    if let Some((w, h)) =
        max_long_edge.and_then(|edge| fit_long_edge(rgba.width(), rgba.height(), edge))
    {
        rgba = image::imageops::resize(&rgba, w, h, FilterType::Lanczos3);
    }
    let (width, height) = (rgba.width(), rgba.height());

    let mut image_bytes = encode_avif(&rgba, quality, ENCODE_SPEED)?;

    // サムネイルは常に長辺 512 に収める。
    let thumb_source = match fit_long_edge(width, height, THUMBNAIL_LONG_EDGE) {
        Some((w, h)) => image::imageops::resize(&rgba, w, h, FilterType::Triangle),
        None => rgba.clone(),
    };
    let mut thumbnail = encode_avif(&thumb_source, quality.min(60), THUMBNAIL_SPEED)?;

    if let Some(json) = vrcx_json {
        let xmp = build_xmp_packet(json);
        // 埋め込みに失敗しても画像は有効なので、その場合は元のバイト列を使う。
        // メタデータはアップロード要求の `metadata` パートでも送っているため欠落しない。
        if let Ok(patched) = embed_xmp(&image_bytes, xmp.as_bytes()) {
            image_bytes = patched;
        }
        if let Ok(patched) = embed_xmp(&thumbnail, xmp.as_bytes()) {
            thumbnail = patched;
        }
    }

    Ok(ConvertedPhoto {
        image: image_bytes,
        thumbnail,
        width,
        height,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 実サンプル 1 枚を変換し、XMP が AVIF から取り出せることを確かめる。
    /// エンコードに時間がかかるため既定では実行しない（`cargo test -- --ignored`）。
    #[test]
    #[ignore]
    fn converts_a_real_screenshot_and_keeps_the_metadata() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../.vrc/VRChat");
        let Some(sample) = walkdir::WalkDir::new(dir)
            .into_iter()
            .filter_map(Result::ok)
            .find(|e| e.path().extension().is_some_and(|x| x == "png"))
        else {
            eprintln!("sample directory is not available; skipping");
            return;
        };

        let json = r#"{"application":"VRCX","version":1}"#;
        let converted = convert_png(sample.path(), 50, Some(1280), Some(json)).unwrap();
        assert!(converted.width.max(converted.height) <= 1280);

        // 埋め込んだ XMP が AVIF から取り出せること。
        let stored = crate::avif_meta::resolve_item_bytes(&converted.image, 2).unwrap();
        let xmp = String::from_utf8(stored).unwrap();
        assert!(xmp.contains("VRCX"));
        eprintln!(
            "image={} bytes thumb={} bytes",
            converted.image.len(),
            converted.thumbnail.len()
        );
    }

    #[test]
    fn long_edge_fit_keeps_aspect_ratio() {
        assert_eq!(fit_long_edge(1920, 1080, 960), Some((960, 540)));
        // 既に収まっている場合は縮小しない。
        assert_eq!(fit_long_edge(800, 600, 1920), None);
    }
}
