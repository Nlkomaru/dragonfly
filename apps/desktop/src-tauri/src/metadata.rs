//! PNG のチャンクだけを読み、VRCX が埋め込んだメタデータを取り出すモジュール。
//!
//! 画素のデコードは行わない。VRCX のテキストチャンクは必ず IDAT より前にあるため、
//! IDAT に到達した時点で走査を打ち切る。これにより数百枚の走査でも I/O が軽い。

use std::io::Read;

use flate2::read::ZlibDecoder;
use serde::{Deserialize, Serialize};

/// PNG のシグネチャ。先頭 8 バイトがこれと一致しないものは PNG として扱わない。
const PNG_SIGNATURE: [u8; 8] = [0x89, b'P', b'N', b'G', b'\r', b'\n', 0x1a, b'\n'];

/// VRCX がテキストチャンクに使うキーワード。
const VRCX_KEYWORD: &[u8] = b"Description";

/// VRChat のユーザー参照（撮影者・同席者の双方に使う）。
/// `packages/core/src/photo.ts` の `PlayerRef` に対応する。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PlayerRef {
    pub id: String,
    pub display_name: String,
}

/// VRChat のワールド参照。`instanceId` はインスタンス種別や region を含む生の文字列。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorldRef {
    pub id: String,
    pub name: String,
    pub instance_id: String,
}

/// VRCX が PNG の iTXt チャンク（キーワード `Description`）に埋める JSON。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct VrcxMetadata {
    pub application: String,
    pub version: u32,
    pub author: PlayerRef,
    pub world: WorldRef,
    #[serde(default)]
    pub players: Vec<PlayerRef>,
}

/// PNG のヘッダ走査結果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PngMeta {
    pub width: u32,
    pub height: u32,
    /// VRCX メタデータ。チャンクが無い・JSON が壊れている場合は None。
    pub vrcx: Option<VrcxMetadata>,
}

/// PNG 走査の失敗理由。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PngParseError {
    /// PNG シグネチャが無い（PNG ではない）。
    NotPng,
    /// IDAT に到達する前にバッファが尽きた。呼び出し側はより長いバッファで再試行できる。
    Truncated,
    /// IHDR が見つからなかった。
    MissingHeader,
}

impl std::fmt::Display for PngParseError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotPng => write!(f, "not a PNG file"),
            Self::Truncated => write!(f, "PNG header data was truncated"),
            Self::MissingHeader => write!(f, "IHDR chunk was not found"),
        }
    }
}

impl std::error::Error for PngParseError {}

/// PNG のバイト列（少なくともヘッダ部分）から解像度と VRCX メタデータを取り出す。
///
/// IDAT / IEND に到達した時点で走査を終えるため、ファイル全体を渡す必要はない。
/// バッファが途中で尽きた場合は [`PngParseError::Truncated`] を返す。
pub fn parse_png_meta(bytes: &[u8]) -> Result<PngMeta, PngParseError> {
    if bytes.len() < 8 || bytes[..8] != PNG_SIGNATURE {
        return Err(PngParseError::NotPng);
    }

    let mut size: Option<(u32, u32)> = None;
    let mut description: Option<String> = None;
    let mut offset = 8usize;

    loop {
        // チャンクヘッダ（長さ4 + 型4）が読めなければ、そこで打ち切る。
        if offset + 8 > bytes.len() {
            return finish(size, description, true);
        }
        let length = u32::from_be_bytes([
            bytes[offset],
            bytes[offset + 1],
            bytes[offset + 2],
            bytes[offset + 3],
        ]) as usize;
        let chunk_type = &bytes[offset + 4..offset + 8];
        let data_start = offset + 8;
        let data_end = match data_start.checked_add(length) {
            // CRC 4 バイトを足した位置が次のチャンク。CRC の検証は行わない。
            Some(end) if end + 4 <= bytes.len() => end,
            _ => return finish(size, description, true),
        };
        let data = &bytes[data_start..data_end];

        match chunk_type {
            b"IHDR" if data.len() >= 8 => {
                let width = u32::from_be_bytes([data[0], data[1], data[2], data[3]]);
                let height = u32::from_be_bytes([data[4], data[5], data[6], data[7]]);
                size = Some((width, height));
            }
            // VRCX の本命。圧縮フラグが立っていれば zlib 展開する。
            b"iTXt" if description.is_none() => {
                if let Some(text) = parse_itxt(data) {
                    description = Some(text);
                }
            }
            // 圧縮テキストのフォールバック。
            b"zTXt" if description.is_none() => {
                if let Some(text) = parse_ztxt(data) {
                    description = Some(text);
                }
            }
            // 非圧縮テキストのフォールバック。
            b"tEXt" if description.is_none() => {
                if let Some(text) = parse_text(data) {
                    description = Some(text);
                }
            }
            // 画素データに入ったらテキストチャンクはもう現れない。
            b"IDAT" | b"IEND" => return finish(size, description, false),
            _ => {}
        }

        offset = data_end + 4;
    }
}

/// 走査結果を [`PngMeta`] に組み立てる。JSON として壊れていた場合はメタデータ無し扱いにする。
fn finish(
    size: Option<(u32, u32)>,
    description: Option<String>,
    truncated: bool,
) -> Result<PngMeta, PngParseError> {
    let Some((width, height)) = size else {
        // IHDR すら読めていないなら、バッファ不足か壊れたファイルかを区別して返す。
        return Err(if truncated {
            PngParseError::Truncated
        } else {
            PngParseError::MissingHeader
        });
    };
    // IHDR は読めたがテキストチャンクを見る前に尽きた場合も、再試行できるようにする。
    if truncated && description.is_none() {
        return Err(PngParseError::Truncated);
    }
    let vrcx = description
        .as_deref()
        .and_then(|json| serde_json::from_str::<VrcxMetadata>(json).ok());
    Ok(PngMeta {
        width,
        height,
        vrcx,
    })
}

/// `keyword\0` を切り出し、キーワードが VRCX のものなら残りのバイト列を返す。
fn split_keyword(data: &[u8]) -> Option<&[u8]> {
    let nul = data.iter().position(|b| *b == 0)?;
    if &data[..nul] != VRCX_KEYWORD {
        return None;
    }
    Some(&data[nul + 1..])
}

/// iTXt: `keyword\0 flag method langTag\0 translatedKeyword\0 text`
fn parse_itxt(data: &[u8]) -> Option<String> {
    let rest = split_keyword(data)?;
    if rest.len() < 2 {
        return None;
    }
    let compressed = rest[0] == 1;
    let rest = &rest[2..];
    // 言語タグと翻訳キーワードは空文字であることが多いが、規格上は任意長。
    let lang_end = rest.iter().position(|b| *b == 0)?;
    let rest = &rest[lang_end + 1..];
    let translated_end = rest.iter().position(|b| *b == 0)?;
    let text = &rest[translated_end + 1..];

    if compressed {
        inflate_to_string(text)
    } else {
        String::from_utf8(text.to_vec()).ok()
    }
}

/// zTXt: `keyword\0 method zlibText`
fn parse_ztxt(data: &[u8]) -> Option<String> {
    let rest = split_keyword(data)?;
    if rest.is_empty() {
        return None;
    }
    inflate_to_string(&rest[1..])
}

/// tEXt: `keyword\0 text`（Latin-1 だが VRCX の JSON は ASCII 範囲を想定）
fn parse_text(data: &[u8]) -> Option<String> {
    let rest = split_keyword(data)?;
    String::from_utf8(rest.to_vec()).ok()
}

/// zlib 圧縮されたテキストを展開する。壊れていれば None。
fn inflate_to_string(compressed: &[u8]) -> Option<String> {
    let mut decoder = ZlibDecoder::new(compressed);
    let mut out = String::new();
    decoder.read_to_string(&mut out).ok()?;
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// テスト用の最小 PNG を組み立てる。CRC は検証しないためゼロで良い。
    fn build_png(chunks: &[(&[u8], Vec<u8>)]) -> Vec<u8> {
        let mut out = PNG_SIGNATURE.to_vec();
        for (kind, data) in chunks {
            out.extend_from_slice(&(data.len() as u32).to_be_bytes());
            out.extend_from_slice(kind);
            out.extend_from_slice(data);
            out.extend_from_slice(&[0, 0, 0, 0]);
        }
        out
    }

    fn ihdr(width: u32, height: u32) -> (&'static [u8], Vec<u8>) {
        let mut data = Vec::new();
        data.extend_from_slice(&width.to_be_bytes());
        data.extend_from_slice(&height.to_be_bytes());
        data.extend_from_slice(&[8, 6, 0, 0, 0]);
        (b"IHDR", data)
    }

    fn itxt(json: &str) -> (&'static [u8], Vec<u8>) {
        let mut data = b"Description\x00".to_vec();
        data.extend_from_slice(&[0, 0]); // 非圧縮
        data.push(0); // language tag ""
        data.push(0); // translated keyword ""
        data.extend_from_slice(json.as_bytes());
        (b"iTXt", data)
    }

    const SAMPLE_JSON: &str = r#"{"application":"VRCX","version":1,
        "author":{"id":"usr_a","displayName":"alice"},
        "world":{"name":"w","id":"wrld_1","instanceId":"wrld_1:0000"},
        "players":[{"id":"usr_b","displayName":"bob"}]}"#;

    #[test]
    fn parses_vrcx_metadata_from_itxt() {
        let png = build_png(&[ihdr(1920, 1080), itxt(SAMPLE_JSON), (b"IDAT", vec![0; 4])]);
        let meta = parse_png_meta(&png).unwrap();
        assert_eq!((meta.width, meta.height), (1920, 1080));
        let vrcx = meta.vrcx.unwrap();
        assert_eq!(vrcx.application, "VRCX");
        assert_eq!(vrcx.world.instance_id, "wrld_1:0000");
        assert_eq!(vrcx.players[0].display_name, "bob");
    }

    #[test]
    fn returns_none_when_no_text_chunk_exists() {
        let png = build_png(&[ihdr(64, 64), (b"IDAT", vec![0; 4])]);
        let meta = parse_png_meta(&png).unwrap();
        assert!(meta.vrcx.is_none());
    }

    #[test]
    fn malformed_json_is_treated_as_missing_metadata() {
        let png = build_png(&[ihdr(64, 64), itxt("{not json"), (b"IDAT", vec![0; 4])]);
        let meta = parse_png_meta(&png).unwrap();
        assert!(meta.vrcx.is_none());
    }

    #[test]
    fn rejects_non_png_input() {
        assert_eq!(parse_png_meta(b"hello").unwrap_err(), PngParseError::NotPng);
    }

    #[test]
    fn reports_truncation_so_caller_can_retry_with_more_bytes() {
        let png = build_png(&[ihdr(64, 64), itxt(SAMPLE_JSON)]);
        let err = parse_png_meta(&png[..40]).unwrap_err();
        assert_eq!(err, PngParseError::Truncated);
    }

    #[test]
    fn reads_zlib_compressed_itxt() {
        use flate2::{write::ZlibEncoder, Compression};
        use std::io::Write;
        let mut encoder = ZlibEncoder::new(Vec::new(), Compression::default());
        encoder.write_all(SAMPLE_JSON.as_bytes()).unwrap();
        let compressed = encoder.finish().unwrap();

        let mut data = b"Description\x00".to_vec();
        data.extend_from_slice(&[1, 0]); // 圧縮あり
        data.push(0);
        data.push(0);
        data.extend_from_slice(&compressed);
        let png = build_png(&[ihdr(8, 8), (b"iTXt", data), (b"IDAT", vec![0; 4])]);

        let meta = parse_png_meta(&png).unwrap();
        assert_eq!(meta.vrcx.unwrap().author.display_name, "alice");
    }
}
