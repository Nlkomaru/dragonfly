// API キー認証。すべての /api ルートはここを通してユーザーを解決する。
// 「認証結果の user_id を必ず引数で渡す」ことで、DB 層に無スコープの経路を作らない。

import { env, waitUntil } from "cloudflare:workers";
import { API_KEY_PREFIX, sha256Hex } from "./ids";
import { findActiveApiKey, touchApiKey } from "./db";

/** 認証済みリクエストの文脈。 */
export interface AuthContext {
  userId: string;
  db: D1Database;
  photos: R2Bucket;
}

/** ハンドラから投げると、そのまま HTTP 応答になるエラー。 */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * `Authorization: Bearer dfly_…` を検証してユーザーを解決する。
 * 鍵が無い / 形式違い / 失効済み / 未知のいずれも 401 にまとめ、
 * どれで落ちたかを応答から推測できないようにする。
 */
export async function authenticate(request: Request): Promise<AuthContext> {
  const header = request.headers.get("Authorization");
  if (!header?.startsWith("Bearer ")) {
    throw new HttpError(401, "missing bearer token");
  }
  const rawKey = header.slice("Bearer ".length).trim();
  if (!rawKey.startsWith(API_KEY_PREFIX)) {
    throw new HttpError(401, "invalid api key");
  }

  const db = env.DB;
  const key = await findActiveApiKey(db, await sha256Hex(rawKey));
  if (!key) throw new HttpError(401, "invalid api key");

  // 最終利用時刻の更新は応答をブロックしない。失敗しても認証結果には影響しない。
  waitUntil(touchApiKey(db, key.id, Date.now()).then(() => undefined));

  return { userId: key.userId, db, photos: env.PHOTOS };
}

/** JSON のエラー応答。 */
export function errorResponse(error: unknown): Response {
  if (error instanceof HttpError) {
    return Response.json({ error: error.message }, { status: error.status });
  }
  console.error("unhandled api error", error);
  return Response.json({ error: "internal error" }, { status: 500 });
}

/**
 * 認証 → ハンドラ実行 → 例外の HTTP 化までをまとめる。
 * 各ルートはこの関数だけを呼び、認証処理を複製しない。
 */
export async function withAuth(
  request: Request,
  handler: (auth: AuthContext) => Promise<Response>,
): Promise<Response> {
  try {
    return await handler(await authenticate(request));
  } catch (error) {
    return errorResponse(error);
  }
}
