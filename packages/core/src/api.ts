// デスクトップ ↔ Web API のリクエスト / レスポンス型。
// Workers 側のハンドラとデスクトップ側の HTTP クライアントが、この型を共有する。

import type { PlayerRef, VrcxMetadata, WorldRef } from "./photo";

/** 1リクエストで問い合わせられるハッシュ数の上限。超える分はクライアントが分割する。 */
export const CHECK_HASH_LIMIT = 500;

/** 送信済み判定の一括問い合わせ。 */
export interface CheckPhotosRequest {
  /** 変換前 PNG の SHA-256。最大 CHECK_HASH_LIMIT 件。 */
  hashes: string[];
}

export interface CheckPhotosResponse {
  /** 既にアップロード済みのハッシュだけを返す。大半が未送信のときに応答が小さくなる。 */
  uploaded: string[];
}

/** アップロード時に画像本体と一緒に送るメタデータ。multipart の `metadata` パート。 */
export interface UploadPhotoMetadata {
  /** 変換前 PNG の SHA-256。これがサーバー上の一意キーになる。 */
  sourceSha256: string;
  takenAt: number;
  width: number;
  height: number;
  /** AVIF 変換で失われるため、抽出済みの VRCX メタデータをそのまま送る。 */
  vrcx: VrcxMetadata;
  tags?: string[];
}

export interface UploadPhotoResponse {
  id: string;
  /** 既存の写真と重複していた場合は true。冪等なので再送しても行は増えない。 */
  deduplicated: boolean;
}

/** 一覧・詳細で返す写真。 */
export interface ApiPhoto {
  id: string;
  sourceSha256: string;
  /** 画像本体の API パス。Web では短命の HMAC 署名付き相対 URL。 */
  url: string;
  /** サムネイルの API パス。Web では短命の HMAC 署名付き相対 URL。 */
  thumbUrl: string;
  takenAt: number;
  width: number;
  height: number;
  byteSize: number;
  world: WorldRef | null;
  players: PlayerRef[];
  tags: string[];
}

export interface ListPhotosResponse {
  photos: ApiPhoto[];
  /** 次ページのカーソル。これ以上無ければ null。 */
  nextCursor: string | null;
}

/** API キー。raw な値は作成時のレスポンスにしか現れない。 */
export interface ApiKeySummary {
  id: string;
  name: string;
  /** 先頭 8 文字。一覧で「どの鍵か」を見分けるためだけに保存する非機密の値。 */
  prefix: string;
  createdAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
}

export interface CreateApiKeyResponse {
  key: ApiKeySummary;
  /** 生成直後の一度きりしか取得できない生の鍵。 */
  rawKey: string;
}

/** 接続テスト用。デスクトップの設定画面が鍵の有効性を確かめるのに使う。 */
export interface MeResponse {
  userId: string;
  displayName: string;
}
