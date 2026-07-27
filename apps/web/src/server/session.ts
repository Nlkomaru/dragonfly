// SSR 中にセッションを解決するためのサーバー関数。
//
// 画面側の `useSession()` はブラウザで /api/auth/get-session を叩くため、
// 初回描画では必ず「未ログイン」から始まってしまう。ログインページへの誘導を
// それに任せると、保護された画面が一瞬見えてから飛ぶ（ちらつく）。
// そこでルートの beforeLoad からこのサーバー関数を呼び、サーバー側で判定する。

import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { getAuth } from "./context";

/** 画面が必要とする最小限のユーザー情報。better-auth のセッションから抜き出したもの。 */
export interface SessionUser {
  id: string;
  name: string;
  image: string | null;
}

/**
 * 現在のリクエストのセッションを返す。未ログインなら null。
 *
 * 認証の解決口は auth.api.getSession() ただ一つ（server/auth.ts の方針）なので、
 * ここでも Cookie を自前で解釈せず、受信したヘッダをそのまま渡す。
 */
export const fetchSessionUser = createServerFn({ method: "GET" }).handler(
  async (): Promise<SessionUser | null> => {
    // `cloudflare:workers` は Workers ランタイム専用の組み込みモジュール。
    // vite の external 指定によりバンドルされずに残るため、トップレベルで import すると
    // クライアントバンドルに裸の specifier が漏れる恐れがある。
    // ハンドラ内の動的 import ならブラウザで評価されることはない。
    const { env } = await import("cloudflare:workers");

    // getRequest() は実物の Headers を持つ Request を返す。
    const session = await getAuth(env).api.getSession({ headers: getRequest().headers });
    if (!session) return null;

    return {
      id: session.user.id,
      name: session.user.name,
      image: session.user.image ?? null,
    };
  },
);
