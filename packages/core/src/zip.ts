// 無圧縮 (store) の ZIP を組み立てる、プラットフォーム非依存の実装。
//
// ブラウザには ZIP を作る API が無い。ただし中身が AVIF（既に圧縮済み）なので
// deflate をかけてもほとんど縮まらず、素の連結で十分に用が足りる。
// そのため圧縮器は持たず、ヘッダの組み立てと CRC-32 だけを実装している。
//
// 対応しているのは ZIP の基本形だけで、zip64 は扱わない。
// 4GB / 65535 件を超える入力は、壊れたファイルを作る代わりに例外にする。

/** ZIP に入れる 1 ファイル。 */
export interface ZipEntry {
  /** 書庫内でのファイル名。UTF-8 で書く（フラグでその旨を立てる）。 */
  name: string;
  data: Uint8Array;
  /** 更新日時。省略すると ZIP の表現できる最古の日時 (1980-01-01) になる。 */
  date?: Date;
}

/** zip64 が要る境界。ここを超えたら素直に諦める。 */
const MAX_TOTAL_BYTES = 0xffffffff;
const MAX_ENTRIES = 0xffff;

/** CRC-32 (IEEE 802.3) のテーブル。初回に一度だけ作る。 */
let crcTable: Uint32Array | null = null;

function getCrcTable(): Uint32Array {
  if (crcTable) return crcTable;
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let bit = 0; bit < 8; bit += 1) {
      // 反転多項式 0xedb88320 で 1 ビットずつ落とす。
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  crcTable = table;
  return table;
}

/** CRC-32 を求める。ZIP のヘッダが要求する値。 */
export function crc32(data: Uint8Array): number {
  const table = getCrcTable();
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i += 1) {
    c = table[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * Date を MS-DOS の日付・時刻表現に変換する。
 * ZIP は 1980 年より前を表現できず、秒は 2 秒刻みになる。
 */
function toDosDateTime(date: Date): { time: number; date: number } {
  const year = date.getFullYear();
  if (year < 1980) return { time: 0, date: (1 << 5) | 1 };
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

/** 書き込み位置を持つ簡易ライタ。すべてリトルエンディアン。 */
class ByteWriter {
  private readonly view: DataView;
  private offset = 0;

  constructor(private readonly buffer: Uint8Array) {
    this.view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  }

  u16(value: number): void {
    this.view.setUint16(this.offset, value, true);
    this.offset += 2;
  }

  u32(value: number): void {
    this.view.setUint32(this.offset, value >>> 0, true);
    this.offset += 4;
  }

  bytes(value: Uint8Array): void {
    this.buffer.set(value, this.offset);
    this.offset += value.length;
  }

  get position(): number {
    return this.offset;
  }
}

/**
 * エントリを無圧縮の ZIP にまとめる。
 *
 * 同じ名前のエントリがあっても弾かない（ZIP 自体は許すが、展開時に上書きされる）。
 * 呼び出し側で一意にしておくこと。
 *
 * @throws 合計サイズが 4GB を超える、または件数が 65535 を超える場合。
 */
export function buildStoredZip(entries: ZipEntry[]): Uint8Array {
  if (entries.length > MAX_ENTRIES) {
    throw new Error(`ZIP に入れられるのは ${MAX_ENTRIES} 件までです`);
  }

  // ファイル名は UTF-8。長さがバイト数で要るので、先に符号化して使い回す。
  const encoder = new TextEncoder();
  const prepared = entries.map((entry) => {
    const name = encoder.encode(entry.name);
    const dos = toDosDateTime(entry.date ?? new Date(0));
    return { name, data: entry.data, crc: crc32(entry.data), dos };
  });

  // 必要な長さを先に数え、確保し直しの無い 1 本のバッファに書く。
  const LOCAL_HEADER = 30;
  const CENTRAL_HEADER = 46;
  const EOCD = 22;
  let localSize = 0;
  let centralSize = 0;
  for (const entry of prepared) {
    localSize += LOCAL_HEADER + entry.name.length + entry.data.length;
    centralSize += CENTRAL_HEADER + entry.name.length;
  }
  const total = localSize + centralSize + EOCD;
  if (total > MAX_TOTAL_BYTES) {
    throw new Error("ZIP が 4GB を超えます。枚数を減らしてください");
  }

  const buffer = new Uint8Array(total);
  const writer = new ByteWriter(buffer);

  // --- ローカルファイルヘッダ + 本体
  const offsets: number[] = [];
  for (const entry of prepared) {
    offsets.push(writer.position);
    writer.u32(0x04034b50);
    writer.u16(20); // 展開に必要なバージョン (2.0)
    writer.u16(0x0800); // bit 11: ファイル名が UTF-8
    writer.u16(0); // 圧縮方式: store
    writer.u16(entry.dos.time);
    writer.u16(entry.dos.date);
    writer.u32(entry.crc);
    writer.u32(entry.data.length); // 圧縮後サイズ（store なので同じ）
    writer.u32(entry.data.length);
    writer.u16(entry.name.length);
    writer.u16(0); // 拡張フィールドなし
    writer.bytes(entry.name);
    writer.bytes(entry.data);
  }

  // --- セントラルディレクトリ
  const centralStart = writer.position;
  for (let i = 0; i < prepared.length; i += 1) {
    const entry = prepared[i];
    writer.u32(0x02014b50);
    writer.u16(20); // 作成バージョン
    writer.u16(20); // 展開に必要なバージョン
    writer.u16(0x0800);
    writer.u16(0);
    writer.u16(entry.dos.time);
    writer.u16(entry.dos.date);
    writer.u32(entry.crc);
    writer.u32(entry.data.length);
    writer.u32(entry.data.length);
    writer.u16(entry.name.length);
    writer.u16(0); // 拡張フィールド
    writer.u16(0); // コメント
    writer.u16(0); // 開始ディスク番号
    writer.u16(0); // 内部属性
    writer.u32(0); // 外部属性
    writer.u32(offsets[i]);
    writer.bytes(entry.name);
  }

  // --- End of central directory
  // 大きさは EOCD を書き始める前に確定させる（書きながら position を読むとずれる）。
  const centralEnd = writer.position;
  writer.u32(0x06054b50);
  writer.u16(0); // このディスクの番号
  writer.u16(0); // セントラルディレクトリのあるディスク
  writer.u16(prepared.length);
  writer.u16(prepared.length);
  writer.u32(centralEnd - centralStart);
  writer.u32(centralStart);
  writer.u16(0); // コメント長

  return buffer;
}
