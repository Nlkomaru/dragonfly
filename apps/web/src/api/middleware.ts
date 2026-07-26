// API の認証と、パスの `:id` から所有者を解決する middleware。
//
// 「誰なのか」を決める場所はこのファイルの requireAuth だけ。
// ブラウザのセッション Cookie もデスクトップの API キーも、
// better-auth の getSession() が同じ形のセッションに畳んでくれるので、
// 呼び出し側は両者を区別する必要がない（詳細は src/server/auth.ts の冒頭）。

import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import { createDb } from "../db/client";
import type { DrizzleDb } from "../db/client";
import { getAuth } from "../server/context";

/** Hono に持たせる型。ハンドラはこれ経由でしか DB / R2 / 所有者に触れない。 */
export interface ApiEnv {
  Bindings: Env;
  Variables: {
    db: DrizzleDb;
    photos: R2Bucket;
    /** 認証されたユーザー（呼び出し元）の ID。 */
    callerId: string;
    callerName: string;
    /** パスの `:id` を解決した結果。クエリのスコープは必ずこの値で絞る。 */
    ownerId: string;
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
  if (requested !== "me" && requested !== callerId) {
    throw new HTTPException(403, { message: "cannot access another user's photos" });
  }
  c.set("ownerId", callerId);
  await next();
});
