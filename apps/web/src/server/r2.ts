// R2 に置いた AVIF の配信。本体とサムネイルで処理が同じなので共通化する。

import type { DrizzleDb } from "../db/client";
import { findPhotoKeys } from "./photos";

export class PhotoObjectNotFound extends Error {}

/**
 * 写真の実体をストリームで返す。
 *
 * キーは内容アドレス (sha256) なので中身が変わることはなく、長期の immutable キャッシュを付けられる。
 * ただしキー自体が事実上の合鍵になるのを避けるため、必ず所有者を確認してから配信する。
 *
 * NOTE (issue #10): その所有者確認は Authorization ヘッダ（または Cookie）を前提にしている。
 * ブラウザの <img src="..."> は Authorization を送らないので、このエンドポイントを
 * そのまま img に指すことはできない。署名付き URL か Cookie 許可のどちらかを入れるまで、
 * Web のギャラリー UI からは画像を表示できない。
 */
export async function streamPhotoObject(
  db: DrizzleDb,
  bucket: R2Bucket,
  ownerId: string,
  photoId: string,
  variant: "image" | "thumb",
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
  // 認証付きの応答なので private。中身は不変なので長期キャッシュしてよい。
  headers.set("Cache-Control", "private, max-age=31536000, immutable");
  // 本文はメモリに載せずそのまま流す。
  return new Response(object.body, { headers });
}
