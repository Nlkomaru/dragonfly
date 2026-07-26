// VRChat のスクリーンショットと、そこに埋め込まれた VRCX メタデータの型。
// デスクトップ (Rust) / Web (Workers) 双方の境界で流れる形なので、
// フィールド名は camelCase に統一し、Rust 側は serde の rename_all で合わせる。

/** VRChat のワールド参照。instanceId はインスタンス種別や region を含む生の文字列。 */
export interface WorldRef {
  id: string;
  name: string;
  instanceId: string;
}

/** VRChat のユーザー参照（撮影者・同席者の双方に使う）。 */
export interface PlayerRef {
  id: string;
  displayName: string;
}

/**
 * VRCX が PNG の iTXt チャンク（キーワード `Description`）に埋める JSON。
 * このメタデータが無い写真は、ワールドも同席者も分からないため UI に出さない。
 */
export interface VrcxMetadata {
  application: string;
  version: number;
  author: PlayerRef;
  world: WorldRef;
  players: PlayerRef[];
}

/** ローカルにあるスクリーンショット1枚。メタデータを持つものだけがこの型になる。 */
export interface Photo {
  /** 絶対パス。ローカルでの一意キーとして扱う。 */
  path: string;
  fileName: string;
  /** 撮影日時（unix ミリ秒）。ファイル名から復元し、駄目なら mtime を使う。 */
  takenAt: number;
  /** 所属する月バケット。`YYYY-MM` 形式で、サイドバーの単位になる。 */
  month: string;
  width: number;
  height: number;
  byteSize: number;
  metadata: VrcxMetadata;
  /** 元 PNG の SHA-256。未計算なら null（ハッシュ計算は走査後に非同期で進む）。 */
  sha256: string | null;
  /** サーバーに送信済みか。未確認の間は false。 */
  uploaded: boolean;
}

/** `scan_photos` の戻り値。 */
export interface ScanResult {
  photos: Photo[];
  /** メタデータが無く一覧から除外した件数。ステータス表示にのみ使う。 */
  skippedCount: number;
  /** 走査したディレクトリ。設定が空のときに既定値へ解決された結果を返す。 */
  rootDir: string;
}

/** サイドバーに出す月バケット。 */
export interface MonthBucket {
  /** `2026-06` 形式。 */
  month: string;
  count: number;
  uploadedCount: number;
}

/** 月ごとの集計を作る。写真は月をまたいで選択できるため、集計は表示専用。 */
export function buildMonthBuckets(photos: Photo[]): MonthBucket[] {
  const map = new Map<string, MonthBucket>();
  for (const photo of photos) {
    const bucket = map.get(photo.month) ?? { month: photo.month, count: 0, uploadedCount: 0 };
    bucket.count += 1;
    if (photo.uploaded) bucket.uploadedCount += 1;
    map.set(photo.month, bucket);
  }
  // 新しい月を上に出す。
  return [...map.values()].sort((a, b) => b.month.localeCompare(a.month));
}

/**
 * VRChat のファイル名から撮影日時と解像度を取り出す。
 * 例: `VRChat_2026-05-27_03-31-44.098_1920x1080.png`
 * 命名規則から外れたファイルもあるため、取れなかった項目は null を返す。
 */
export function parseVrchatFileName(fileName: string): {
  takenAt: number | null;
  width: number | null;
  height: number | null;
} {
  const match = /^VRChat_(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})\.(\d{3})(?:_(\d+)x(\d+))?/.exec(
    fileName,
  );
  if (!match) return { takenAt: null, width: null, height: null };

  const [, y, mo, d, h, mi, s, ms, w, ht] = match;
  // ファイル名の時刻はローカルタイムで書かれているため、ローカルとして解釈する。
  const takenAt = new Date(+y, +mo - 1, +d, +h, +mi, +s, +ms).getTime();
  return {
    takenAt: Number.isNaN(takenAt) ? null : takenAt,
    width: w ? +w : null,
    height: ht ? +ht : null,
  };
}

/** unix ミリ秒から `YYYY-MM` のバケット名を作る。 */
export function toMonthKey(takenAt: number): string {
  const date = new Date(takenAt);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}
