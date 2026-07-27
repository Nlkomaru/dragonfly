// R2 に置いた AVIF の配信。本体とサムネイルで処理が同じなので共通化する。

import type { DrizzleDb } from "../db/client";
import { findPhotoKeys } from "./photos";

export class PhotoObjectNotFound extends Error {}

/** 配信レスポンスの Cache-Control 方針。 */
export type PhotoStreamCache =
  | {
      /** 署名付き URL 経由。CDN / ブラウザに public で残りの寿命だけキャッシュさせる。 */
      mode: "signed";
      /** 署名の exp（unix seconds）。 */
      exp: number;
    }
  | {
      /** セッション / API キー経由。認証付き応答なので private の長期キャッシュ。 */
      mode: "private";
    };

/**
 * 写真の実体をストリームで返す。
 *
 * キーは内容アドレス (sha256) なので中身が変わることはなく、immutable を付けられる。
 * ただしキー自体が事実上の合鍵になるのを避けるため、必ず所有者を確認してから配信する。
 *
 * 認可は呼び出し側（署名 URL またはセッション）で済ませてある前提。
 * Cache-Control だけは経路に応じて変える:
 * - 署名: public, max-age=残秒, immutable（URL 自体に期限がある）
 * - 資格情報: private, max-age=1年, immutable
 */
export async function streamPhotoObject(
  db: DrizzleDb,
  bucket: R2Bucket,
  ownerId: string,
  photoId: string,
  variant: "image" | "thumb",
  cache: PhotoStreamCache = { mode: "private" },
): Promise<Response> {
  const keys = await findPhotoKeys(db, ownerId, photoId);
  if (!keys) throw new PhotoObjectNotFound("photo not found");

  const key = variant === "thumb" ? keys.thumbKey : keys.r2Key;
  if (!key) throw new PhotoObjectNotFound("thumbnail not available");

  const object = await bucket.get(key);
  if (!object) throw new PhotoObjectNotFound("object not found");

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("Content-Type", object.httpMetadata?.contentType ?? "image/avif");
  headers.set("etag", object.httpEtag);
  if (cache.mode === "signed") {
    // 期限を過ぎた max-age は 0。負数を出さない。
    const remaining = Math.max(0, cache.exp - Math.floor(Date.now() / 1000));
    headers.set("Cache-Control", `public, max-age=${remaining}, immutable`);
  } else {
    headers.set("Cache-Control", "private, max-age=31536000, immutable");
  }
  // 本文はメモリに載せずそのまま流す。
  return new Response(object.body, { headers });
}
