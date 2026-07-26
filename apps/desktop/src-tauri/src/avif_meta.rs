//! AVIF（ISOBMFF）の `meta` ボックスに XMP アイテムを差し込むためのモジュール。
//!
//! AVIF には PNG の tEXt/iTXt に相当する仕組みが無いため、VRCX のメタデータは
//! XMP アイテムとしてファイルに同梱する。ravif が吐く AVIF は
//! `ftyp` / `meta` / `mdat` の並びなので、次の手順でバイト列を組み替える。
//!
//! 1. `iinf` に XMP 用の `infe`（item_type = `mime`）を1件追加する
//! 2. `iref` に `cdsc`（XMP → 主画像）の参照を追加する
//! 3. `iloc` に XMP の位置を追加する
//! 4. XMP 本体を `mdat` の末尾に足す
//! 5. `meta` が伸びた分だけ、既存の `iloc` オフセットを全て後ろへずらす
//!
//! 5 を誤ると画像が復号できなくなるため、テストで主画像のバイト列が
//! 変換前後で一致することを必ず確認する。

/// XMP アイテムの MIME タイプ。
const XMP_CONTENT_TYPE: &[u8] = b"application/rdf+xml\0";
/// XMP アイテムの名前。
const XMP_ITEM_NAME: &[u8] = b"XMP\0";

/// ボックスの位置情報。
#[derive(Debug, Clone, Copy)]
struct BoxSpan {
    /// ボックス先頭（サイズフィールド）の位置。
    start: usize,
    /// ボックス終端（次のボックス先頭）の位置。
    end: usize,
    /// ペイロード先頭（ヘッダ直後）の位置。
    payload: usize,
}

/// 指定範囲の直下にあるボックスを列挙する。64bit サイズには対応しない。
fn list_boxes(
    bytes: &[u8],
    mut cursor: usize,
    end: usize,
) -> Result<Vec<([u8; 4], BoxSpan)>, String> {
    let mut boxes = Vec::new();
    while cursor + 8 <= end {
        let size = u32::from_be_bytes(bytes[cursor..cursor + 4].try_into().unwrap()) as usize;
        let mut kind = [0u8; 4];
        kind.copy_from_slice(&bytes[cursor + 4..cursor + 8]);
        // size == 0 は「ファイル末尾まで」、size == 1 は 64bit サイズ。
        let box_end = match size {
            0 => end,
            1 => return Err("64-bit box sizes are not supported".into()),
            _ => cursor + size,
        };
        if box_end > end || box_end <= cursor {
            return Err("malformed box size".into());
        }
        boxes.push((
            kind,
            BoxSpan {
                start: cursor,
                end: box_end,
                payload: cursor + 8,
            },
        ));
        cursor = box_end;
    }
    Ok(boxes)
}

/// 名前でボックスを探す。
fn find_box<'a>(boxes: &'a [([u8; 4], BoxSpan)], name: &[u8; 4]) -> Option<&'a BoxSpan> {
    boxes
        .iter()
        .find(|(kind, _)| kind == name)
        .map(|(_, span)| span)
}

/// 可変長のビッグエンディアン整数を読む。
fn read_uint(bytes: &[u8], offset: usize, size: usize) -> u64 {
    let mut value = 0u64;
    for byte in &bytes[offset..offset + size] {
        value = (value << 8) | *byte as u64;
    }
    value
}

/// 可変長のビッグエンディアン整数を書く。
fn write_uint(bytes: &mut [u8], offset: usize, size: usize, value: u64) {
    for i in 0..size {
        bytes[offset + i] = (value >> (8 * (size - 1 - i))) as u8;
    }
}

/// `iloc` の解析結果。オフセットの書き換えに必要な情報だけ持つ。
struct ILocLayout {
    version: u8,
    offset_size: usize,
    length_size: usize,
    base_offset_size: usize,
    index_size: usize,
    item_count: u64,
    /// 絶対オフセットを保持しているフィールドの (位置, サイズ)。ボックス先頭からの相対位置。
    offset_fields: Vec<(usize, usize)>,
    /// item_count フィールドの (位置, サイズ)。
    count_field: (usize, usize),
}

/// `iloc` を解析して、ずらすべきオフセットフィールドの位置を集める。
fn parse_iloc(iloc: &[u8]) -> Result<ILocLayout, String> {
    if iloc.len() < 16 {
        return Err("iloc box is too small".into());
    }
    let version = iloc[8];
    let mut cursor = 12; // 8 (header) + 4 (version/flags)
    let offset_size = (iloc[cursor] >> 4) as usize;
    let length_size = (iloc[cursor] & 0x0f) as usize;
    let base_offset_size = (iloc[cursor + 1] >> 4) as usize;
    let index_size = if version >= 1 {
        (iloc[cursor + 1] & 0x0f) as usize
    } else {
        0
    };
    cursor += 2;

    let count_size = if version < 2 { 2 } else { 4 };
    let count_field = (cursor, count_size);
    let item_count = read_uint(iloc, cursor, count_size);
    cursor += count_size;

    let mut offset_fields = Vec::new();
    for _ in 0..item_count {
        cursor += if version < 2 { 2 } else { 4 }; // item_ID
        if version >= 1 {
            cursor += 2; // reserved + construction_method
        }
        cursor += 2; // data_reference_index
        let base_offset_pos = cursor;
        cursor += base_offset_size;
        let extent_count = read_uint(iloc, cursor, 2);
        cursor += 2;

        // 絶対位置 = base_offset + extent_offset なので、ずらすのはどちらか一方だけ。
        if base_offset_size > 0 {
            offset_fields.push((base_offset_pos, base_offset_size));
        }
        for _ in 0..extent_count {
            if version >= 1 && index_size > 0 {
                cursor += index_size;
            }
            if base_offset_size == 0 && offset_size > 0 {
                offset_fields.push((cursor, offset_size));
            }
            cursor += offset_size + length_size;
        }
        if cursor > iloc.len() {
            return Err("iloc box is truncated".into());
        }
    }

    Ok(ILocLayout {
        version,
        offset_size,
        length_size,
        base_offset_size,
        index_size,
        item_count,
        offset_fields,
        count_field,
    })
}

impl ILocLayout {
    /// 追加する1件分のエントリ長。delta の事前計算に使う。
    fn new_entry_len(&self) -> usize {
        let id_size = if self.version < 2 { 2 } else { 4 };
        let ctor_size = if self.version >= 1 { 2 } else { 0 };
        let index = if self.version >= 1 {
            self.index_size
        } else {
            0
        };
        id_size
            + ctor_size
            + 2
            + self.base_offset_size
            + 2
            + index
            + self.offset_size
            + self.length_size
    }

    /// 追加する1件分のエントリを組み立てる。base_offset は 0 にして絶対値を extent 側に書く。
    fn build_entry(&self, item_id: u32, offset: u64, length: u64) -> Vec<u8> {
        let mut out = Vec::with_capacity(self.new_entry_len());
        let id_size = if self.version < 2 { 2 } else { 4 };
        push_uint(&mut out, id_size, item_id as u64);
        if self.version >= 1 {
            // reserved(12bit) + construction_method(4bit) = 0（ファイル内オフセット）
            out.extend_from_slice(&[0, 0]);
        }
        push_uint(&mut out, 2, 0); // data_reference_index
        if self.base_offset_size > 0 {
            push_uint(&mut out, self.base_offset_size, 0);
        }
        push_uint(&mut out, 2, 1); // extent_count
        if self.version >= 1 && self.index_size > 0 {
            push_uint(&mut out, self.index_size, 0);
        }
        push_uint(&mut out, self.offset_size, offset);
        push_uint(&mut out, self.length_size, length);
        out
    }
}

/// 可変長のビッグエンディアン整数を末尾に追加する。
fn push_uint(out: &mut Vec<u8>, size: usize, value: u64) {
    for i in 0..size {
        out.push((value >> (8 * (size - 1 - i))) as u8);
    }
}

/// ボックスヘッダ（サイズ + 型）を先頭に付けて完成させる。
fn finish_box(kind: &[u8; 4], payload: Vec<u8>) -> Vec<u8> {
    let mut out = Vec::with_capacity(payload.len() + 8);
    out.extend_from_slice(&((payload.len() + 8) as u32).to_be_bytes());
    out.extend_from_slice(kind);
    out.extend_from_slice(&payload);
    out
}

/// `iinf` を走査して、使われている最大の item_ID を返す。
fn max_item_id(iinf: &[u8]) -> Result<u32, String> {
    let version = iinf[8];
    let header = if version == 0 { 14 } else { 16 };
    let children = list_boxes(iinf, header, iinf.len())?;
    let mut max = 0u32;
    for (kind, span) in children {
        if &kind != b"infe" {
            continue;
        }
        let infe = &iinf[span.start..span.end];
        let infe_version = infe[8];
        // version 0/1 は 16bit、2 は 16bit、3 は 32bit の item_ID。
        let id = if infe_version >= 3 {
            read_uint(infe, 12, 4) as u32
        } else {
            read_uint(infe, 12, 2) as u32
        };
        max = max.max(id);
    }
    Ok(max)
}

/// XMP アイテム用の `infe` ボックスを作る。
fn build_infe(item_id: u32) -> Vec<u8> {
    let mut payload = vec![2u8, 0, 0, 0]; // version = 2, flags = 0
    push_uint(&mut payload, 2, item_id as u64);
    push_uint(&mut payload, 2, 0); // item_protection_index
    payload.extend_from_slice(b"mime");
    payload.extend_from_slice(XMP_ITEM_NAME);
    payload.extend_from_slice(XMP_CONTENT_TYPE);
    finish_box(b"infe", payload)
}

/// XMP → 主画像の `cdsc` 参照を作る。
fn build_cdsc(from_item: u32, to_item: u32) -> Vec<u8> {
    let mut payload = Vec::new();
    push_uint(&mut payload, 2, from_item as u64);
    push_uint(&mut payload, 2, 1); // reference_count
    push_uint(&mut payload, 2, to_item as u64);
    finish_box(b"cdsc", payload)
}

/// VRCX メタデータの JSON を包んだ最小の XMP パケットを作る。
/// 独自プロパティ `dragonfly:vrcx` に JSON をそのまま入れる。
pub fn build_xmp_packet(vrcx_json: &str) -> String {
    // XML の特殊文字だけ最低限エスケープする。
    let escaped = vrcx_json
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;");
    format!(
        "<?xpacket begin=\"\u{feff}\" id=\"W5M0MpCehiHzreSzNTczkc9d\"?>\
<x:xmpmeta xmlns:x=\"adobe:ns:meta/\">\
<rdf:RDF xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\">\
<rdf:Description rdf:about=\"\" xmlns:dragonfly=\"https://dragonfly.vrc.nikomaru.dev/ns/1.0/\">\
<dragonfly:vrcx>{escaped}</dragonfly:vrcx>\
</rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end=\"w\"?>"
    )
}

/// AVIF に XMP アイテムを差し込んだ新しいバイト列を返す。
///
/// 構造が想定外（`meta` / `mdat` が無い、`mdat` が末尾でない等）の場合はエラーを返すので、
/// 呼び出し側は元のバイト列をそのまま使えばよい。
pub fn embed_xmp(avif: &[u8], xmp: &[u8]) -> Result<Vec<u8>, String> {
    let top = list_boxes(avif, 0, avif.len())?;
    let meta = *find_box(&top, b"meta").ok_or("meta box was not found")?;
    let mdat = *find_box(&top, b"mdat").ok_or("mdat box was not found")?;
    if mdat.start < meta.start {
        return Err("mdat must follow meta".into());
    }
    if mdat.end != avif.len() {
        return Err("mdat must be the last box".into());
    }

    // meta は FullBox なので version/flags の 4 バイトを飛ばして子を読む。
    let meta_children = list_boxes(avif, meta.payload + 4, meta.end)?;
    let iloc_span = *find_box(&meta_children, b"iloc").ok_or("iloc box was not found")?;
    let iinf_span = *find_box(&meta_children, b"iinf").ok_or("iinf box was not found")?;
    let pitm_span = *find_box(&meta_children, b"pitm").ok_or("pitm box was not found")?;
    let iref_span = find_box(&meta_children, b"iref").copied();

    let iloc_bytes = &avif[iloc_span.start..iloc_span.end];
    let iinf_bytes = &avif[iinf_span.start..iinf_span.end];
    let layout = parse_iloc(iloc_bytes)?;
    if layout.offset_size == 0 {
        return Err("iloc has no offset field to patch".into());
    }

    // 主画像の item_ID（pitm）。XMP はここに cdsc で紐付ける。
    let pitm_version = avif[pitm_span.payload];
    let primary_item = if pitm_version == 0 {
        read_uint(avif, pitm_span.payload + 4, 2) as u32
    } else {
        read_uint(avif, pitm_span.payload + 4, 4) as u32
    };
    let new_item_id = max_item_id(iinf_bytes)? + 1;

    // meta が伸びる量は、追加する各ボックスの長さから先に確定できる。
    let infe = build_infe(new_item_id);
    let cdsc = build_cdsc(new_item_id, primary_item);
    let iref_growth = match iref_span {
        Some(_) => cdsc.len(),
        // iref を新設する場合は FullBox ヘッダ 12 バイトが増える。
        None => cdsc.len() + 12,
    };
    let delta = infe.len() + layout.new_entry_len() + iref_growth;

    // XMP は mdat の末尾に置く。meta が delta だけ伸びるので位置も後ろへずれる。
    let xmp_offset = (mdat.end + delta) as u64;

    // --- iloc を作り直す（既存オフセットへ delta を加算し、末尾に XMP を追加） ---
    let mut new_iloc = iloc_bytes.to_vec();
    for (pos, size) in &layout.offset_fields {
        let current = read_uint(&new_iloc, *pos, *size);
        write_uint(&mut new_iloc, *pos, *size, current + delta as u64);
    }
    write_uint(
        &mut new_iloc,
        layout.count_field.0,
        layout.count_field.1,
        layout.item_count + 1,
    );
    new_iloc.extend_from_slice(&layout.build_entry(new_item_id, xmp_offset, xmp.len() as u64));
    let new_len = new_iloc.len() as u32;
    new_iloc[0..4].copy_from_slice(&new_len.to_be_bytes());

    // --- iinf に infe を追加し、entry_count を増やす ---
    let mut new_iinf = iinf_bytes.to_vec();
    let iinf_version = new_iinf[8];
    if iinf_version == 0 {
        let count = read_uint(&new_iinf, 12, 2) + 1;
        write_uint(&mut new_iinf, 12, 2, count);
    } else {
        let count = read_uint(&new_iinf, 12, 4) + 1;
        write_uint(&mut new_iinf, 12, 4, count);
    }
    new_iinf.extend_from_slice(&infe);
    let new_len = new_iinf.len() as u32;
    new_iinf[0..4].copy_from_slice(&new_len.to_be_bytes());

    // --- iref に cdsc を追加（無ければ新設） ---
    let new_iref = match iref_span {
        Some(span) => {
            let mut bytes = avif[span.start..span.end].to_vec();
            bytes.extend_from_slice(&cdsc);
            let new_len = bytes.len() as u32;
            bytes[0..4].copy_from_slice(&new_len.to_be_bytes());
            bytes
        }
        None => {
            let mut payload = vec![0u8, 0, 0, 0]; // version = 0, flags = 0
            payload.extend_from_slice(&cdsc);
            finish_box(b"iref", payload)
        }
    };

    // --- meta を組み立て直す ---
    let mut meta_payload = avif[meta.payload..meta.payload + 4].to_vec(); // version/flags
    for (kind, span) in &meta_children {
        match kind {
            b"iloc" => meta_payload.extend_from_slice(&new_iloc),
            b"iinf" => meta_payload.extend_from_slice(&new_iinf),
            b"iref" => meta_payload.extend_from_slice(&new_iref),
            _ => meta_payload.extend_from_slice(&avif[span.start..span.end]),
        }
    }
    if iref_span.is_none() {
        meta_payload.extend_from_slice(&new_iref);
    }
    let new_meta = finish_box(b"meta", meta_payload);
    debug_assert_eq!(new_meta.len(), (meta.end - meta.start) + delta);
    if new_meta.len() != (meta.end - meta.start) + delta {
        return Err("meta box size did not grow as predicted".into());
    }

    // --- ファイル全体を組み立てる ---
    let mut out = Vec::with_capacity(avif.len() + delta + xmp.len());
    out.extend_from_slice(&avif[..meta.start]);
    out.extend_from_slice(&new_meta);
    out.extend_from_slice(&avif[meta.end..mdat.start]);
    // mdat は XMP の分だけ伸びる。
    let new_mdat_len = (mdat.end - mdat.start + xmp.len()) as u32;
    out.extend_from_slice(&new_mdat_len.to_be_bytes());
    out.extend_from_slice(b"mdat");
    out.extend_from_slice(&avif[mdat.payload..mdat.end]);
    out.extend_from_slice(xmp);
    Ok(out)
}

/// item_ID からファイル内のバイト範囲を解決する（テストと検証用）。
pub fn resolve_item_bytes(avif: &[u8], item_id: u32) -> Option<Vec<u8>> {
    let top = list_boxes(avif, 0, avif.len()).ok()?;
    let meta = *find_box(&top, b"meta")?;
    let children = list_boxes(avif, meta.payload + 4, meta.end).ok()?;
    let iloc_span = *find_box(&children, b"iloc")?;
    let iloc = &avif[iloc_span.start..iloc_span.end];

    let version = iloc[8];
    let offset_size = (iloc[12] >> 4) as usize;
    let length_size = (iloc[12] & 0x0f) as usize;
    let base_offset_size = (iloc[13] >> 4) as usize;
    let index_size = if version >= 1 {
        (iloc[13] & 0x0f) as usize
    } else {
        0
    };
    let count_size = if version < 2 { 2 } else { 4 };
    let item_count = read_uint(iloc, 14, count_size);
    let mut cursor = 14 + count_size;

    for _ in 0..item_count {
        let id_size = if version < 2 { 2 } else { 4 };
        let id = read_uint(iloc, cursor, id_size) as u32;
        cursor += id_size;
        if version >= 1 {
            cursor += 2;
        }
        cursor += 2; // data_reference_index
        let base = read_uint(iloc, cursor, base_offset_size);
        cursor += base_offset_size;
        let extent_count = read_uint(iloc, cursor, 2);
        cursor += 2;
        let mut collected = Vec::new();
        for _ in 0..extent_count {
            if version >= 1 && index_size > 0 {
                cursor += index_size;
            }
            let offset = read_uint(iloc, cursor, offset_size);
            cursor += offset_size;
            let length = read_uint(iloc, cursor, length_size);
            cursor += length_size;
            if id == item_id {
                let start = (base + offset) as usize;
                collected.extend_from_slice(avif.get(start..start + length as usize)?);
            }
        }
        if id == item_id {
            return Some(collected);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 単色画像を AVIF にして、XMP 埋め込みの入出力を試す。
    fn encode_sample() -> Vec<u8> {
        let pixels = vec![rgb::RGBA8::new(10, 20, 30, 255); 16 * 16];
        let img = ravif::Img::new(pixels.as_slice(), 16, 16);
        ravif::Encoder::new()
            .with_quality(50.0)
            .with_speed(10)
            .encode_rgba(img)
            .unwrap()
            .avif_file
    }

    #[test]
    fn embedding_xmp_keeps_the_primary_image_bytes_intact() {
        let original = encode_sample();
        let xmp = build_xmp_packet(r#"{"application":"VRCX"}"#);
        let patched = embed_xmp(&original, xmp.as_bytes()).unwrap();

        // 主画像 (item 1) のバイト列が変換前後で一致することが最重要の不変条件。
        let before = resolve_item_bytes(&original, 1).unwrap();
        let after = resolve_item_bytes(&patched, 1).unwrap();
        assert_eq!(before, after);
        assert!(!before.is_empty());
    }

    #[test]
    fn embedded_xmp_round_trips() {
        let original = encode_sample();
        let xmp = build_xmp_packet(r#"{"application":"VRCX","version":1}"#);
        let patched = embed_xmp(&original, xmp.as_bytes()).unwrap();

        // 新しい item_ID は既存の最大値 + 1。
        let stored = resolve_item_bytes(&patched, 2).unwrap();
        assert_eq!(String::from_utf8(stored).unwrap(), xmp);
    }
}
