// ギャラリー初回ページ用のサーバー関数。
// Cookie セッションを SSR 中に解決し、D1 から listPhotos する。
// クライアントの無限スクロールは /api/v1/users/me/photos を直接叩く。

import type { ListPhotosResponse } from "@dragonfly/core";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { createDb } from "../db/client";
import { getAuth } from "./context";
import { listPhotos, type ListPhotosFilters } from "./photos";

/** loader / 画面から渡すフィルタ。listPhotos と同じ形。 */
export type FetchPhotosPageInput = ListPhotosFilters;

/**
 * ログイン中ユーザーの写真 1 ページを返す。
 * 未ログインなら throw（ルートの beforeLoad で弾かれる想定だが、二重に守る）。
 */
export const fetchPhotosPage = createServerFn({ method: "GET" })
  .validator((data: FetchPhotosPageInput) => data)
  .handler(async ({ data }): Promise<ListPhotosResponse> => {
    // cloudflare:workers はハンドラ内の動的 import（session.ts と同じ理由）。
    const { env } = await import("cloudflare:workers");

    const session = await getAuth(env).api.getSession({ headers: getRequest().headers });
    if (!session) {
      // beforeLoad をすり抜けた場合の保険。空ではなく明示的に失敗させる。
      throw new Error("Unauthorized");
    }

    const db = createDb(env.DB);
    // 署名付き URL の HMAC 鍵は BETTER_AUTH_SECRET を流用する（issue #10）。
    return listPhotos(db, session.user.id, data, env.BETTER_AUTH_SECRET);
  });
