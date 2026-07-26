// R2 に置いた AVIF の配信。本体とサムネイルで処理が同じなので共通化する。
import type { AuthContext } from "./auth";
import { HttpError } from "./auth";
import { findPhotoKeys } from "./db";

/**
 * 写真の実体をストリームで返す。
 * キーは内容アドレス (sha256) なので中身が変わることはなく、長期の immutable キャッシュを付けられる。
 * ただしキー自体が事実上の合鍵になるのを避けるため、必ず所有者を確認してから配信する。
 */
export async function streamPhotoObject(
  auth: AuthContext,
  photoId: string,
  variant: "image" | "thumb",
): Promise<Response> {
  const keys = await findPhotoKeys(auth.db, auth.userId, photoId);
  if (!keys) throw new HttpError(404, "photo not found");

  const key = variant === "thumb" ? keys.thumbKey : keys.r2Key;
  if (!key) throw new HttpError(404, "thumbnail not available");

  const object = await auth.photos.get(key);
  if (!object) throw new HttpError(404, "object not found");

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("Content-Type", object.httpMetadata?.contentType ?? "image/avif");
  headers.set("etag", object.httpEtag);
  headers.set("Cache-Control", "private, max-age=31536000, immutable");
  // 本文はメモリに載せずそのまま流す。
  return new Response(object.body, { headers });
}
