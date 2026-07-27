// API の認証と、パスの `:id` から所有者を解決する middleware。
//
// 「誰なのか」を決める場所はこのファイルの requireAuth（と画像用の
// requireAuthOrSignedPhoto）。ブラウザのセッション Cookie もデスクトップの
// API キーも、better-auth の getSession() が同じ形のセッションに畳んでくれるので、
// 呼び出し側は両者を区別する必要がない（詳細は src/server/auth.ts の冒頭）。
// 画像 / サムネだけは HMAC 署名付き URL でも通す（issue #10）。

import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import { createDb } from "../db/client";
import type { DrizzleDb } from "../db/client";
import { getAuth } from "../server/context";
import { verifySignedPhotoUrl } from "../server/signedUrl";

/** Hono に持たせる型。ハンドラはこれ経由でしか DB / R2 / 所有者に触れない。 */
export interface ApiEnv {
  Bindings: Env;
  Variables: {
    db: DrizzleDb;
    photos: R2Bucket;
    /** 認証されたユーザー（呼び出し元）の ID。署名だけ経由の画像配信では未設定。 */
    callerId?: string;
    callerName?: string;
    /** パスの `:id` を解決した結果。クエリのスコープは必ずこの値で絞る。 */
    ownerId: string;
    /**
     * 署名付き URL で画像を配信するときの exp（unix seconds）。
     * Cache-Control の max-age 算出にだけ使う。資格情報経由では未設定。
     */
    signedPhotoExp?: number;
  };
}

/**
 * セッション（Cookie）または API キー（Authorization: Bearer dfly_...）を検証する。
 * どちらでも駄目なら 401。理由は区別せず、どこで落ちたかを応答から推測できないようにする。
 */
export const requireAuth = createMiddleware<ApiEnv>(async (c, next) => {
  const auth = getAuth(c.env);
  // ヘッダをそのまま渡す。Cookie と Authorization の両方がこの 1 回で解釈される。
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) {
    throw new HTTPException(401, { message: "authentication required" });
  }

  c.set("db", createDb(c.env.DB));
  c.set("photos", c.env.PHOTOS);
  c.set("callerId", session.user.id);
  c.set("callerName", session.user.name);
  await next();
});

/**
 * パスの `:id` を実際の所有者 ID に解決する。
 * `me` は呼び出し元自身の別名。他人の ID を指定した場合は 403 で、
 * 「存在するかどうか」も含めて何も返さない。
 *
 * requireAuth の後にだけ使うこと（callerId が入っている前提）。
 */
export const resolveOwner = createMiddleware<ApiEnv>(async (c, next) => {
  const requested = c.req.param("id");
  const callerId = c.get("callerId");
  // requireAuth の後専用。callerId が無ければ設定ミスなので 401。
  if (!callerId) {
    throw new HTTPException(401, { message: "authentication required" });
  }
  if (requested !== "me" && requested !== callerId) {
    throw new HTTPException(403, { message: "cannot access another user's photos" });
  }
  c.set("ownerId", callerId);
  await next();
});

/**
 * 画像 / サムネ配信専用。有効な署名クエリがあればセッション無しで通す。
 * 署名が無い・無効なときは従来どおりセッション / API キーを要求する。
 *
 * 署名パスでは path の `:id` が payload に埋め込まれる実 ownerId と一致する必要がある。
 * そのため `me` は署名だけでは解決できない（セッションがあるときだけ `me` を許す）。
 */
export function requireAuthOrSignedPhoto(variant: "image" | "thumb") {
  return createMiddleware<ApiEnv>(async (c, next) => {
    const requestedId = c.req.param("id");
    const photoId = c.req.param("photoId");
    const exp = c.req.query("exp");
    const sig = c.req.query("sig");

    // 署名クエリが揃っていて、かつ path が実 ID のときだけ署名を試す。
    // `me` は payload に書けないので署名パスでは使えない。
    if (requestedId && requestedId !== "me" && photoId && exp != null && sig != null) {
      const verified = await verifySignedPhotoUrl({
        secret: c.env.BETTER_AUTH_SECRET,
        ownerId: requestedId,
        photoId,
        variant,
        exp,
        sig,
      });
      if (verified.ok) {
        c.set("db", createDb(c.env.DB));
        c.set("photos", c.env.PHOTOS);
        c.set("ownerId", requestedId);
        c.set("signedPhotoExp", verified.exp);
        await next();
        return;
      }
      // 署名が無効でも、このあとセッションがあれば資格情報パスにフォールバックする。
    }

    const auth = getAuth(c.env);
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) {
      throw new HTTPException(401, { message: "authentication required" });
    }

    c.set("db", createDb(c.env.DB));
    c.set("photos", c.env.PHOTOS);
    c.set("callerId", session.user.id);
    c.set("callerName", session.user.name);

    // resolveOwner と同じ規則: me または本人 ID のみ。
    if (requestedId !== "me" && requestedId !== session.user.id) {
      throw new HTTPException(403, { message: "cannot access another user's photos" });
    }
    c.set("ownerId", session.user.id);
    await next();
  });
}
