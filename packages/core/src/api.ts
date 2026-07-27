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

/**
 * デスクトップの `upload_photos` が返す 1 枚分の結果。
 * 1 枚の失敗で全体を止めないため、成否と理由を写真ごとに持ち帰る。
 */
export interface UploadOutcome {
  /** 送信元のローカルパス。写真一覧のキーと同じ値。 */
  path: string;
  sha256: string | null;
  uploaded: boolean;
  /** 既にサーバーにあった場合は true（送信自体は成功扱い）。 */
  deduplicated: boolean;
  error: string | null;
}

/** `upload_photos` の戻り値。 */
export interface UploadSummary {
  results: UploadOutcome[];
  succeeded: number;
  failed: number;
}

/** `convert_progress` イベントの本体。変換に着手した件数だけを持つ。 */
export interface ConvertProgress {
  processed: number;
  total: number;
  currentPath: string;
}

/**
 * `upload_progress` イベントの本体。
 * 成否は 1 枚終わるごとに確定するため、待っている間に内訳が動くよう
 * 変換側とは違って `succeeded` / `failed` も一緒に送る。
 */
export interface UploadProgress extends ConvertProgress {
  /** ここまでに送信できた件数（重複扱いも成功に数える）。 */
  succeeded: number;
  /** ここまでに失敗した件数。 */
  failed: number;
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

/** 写真 1 枚のタグを置き換える要求。ここに無いタグはその写真から外れる。 */
export interface PutPhotoTagsRequest {
  tags: string[];
}

export interface PutPhotoTagsResponse {
  /** 反映後のタグ。 */
  tags: string[];
}

/** タグ入力の補完に使う、そのユーザーが使ったことのあるタグ名。 */
export interface ListTagsResponse {
  tags: string[];
}

/** 絞り込みの選択肢に出すワールド。ID ではなく名前で選べるようにするためのもの。 */
export interface WorldFacet {
  id: string;
  /** 最後に記録された表示名。空文字なら名前が取れていない。 */
  name: string;
  /** そのユーザーの写真のうち、このワールドで撮られた枚数。並び順に使う。 */
  count: number;
}

/** 絞り込みの選択肢に出す VRChat ユーザー（撮影者と同席者の両方）。 */
export interface PlayerFacet {
  id: string;
  displayName: string;
  /** そのユーザーの写真のうち、この人が写っている（撮った）枚数。 */
  count: number;
}

/**
 * 絞り込み UI の選択肢。呼び出し元自身の写真から作るので、
 * 他人の写真に出てくるワールドや人は決して含まれない。
 */
export interface ListFacetsResponse {
  worlds: WorldFacet[];
  players: PlayerFacet[];
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
