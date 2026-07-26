// better-auth の組み立て。認証まわりの設定はすべてここに集約する。
//
// Worker の secrets / vars は `process.env` ではなく `env` バインディングに載るため、
// secret・baseURL・Discord のクレデンシャルは必ず明示的に渡す。
// 既定値に頼ると undefined のまま起動して、実行時まで気付けない。
//
// 認証の解決口は 1 つだけ: `auth.api.getSession({ headers })`。
//   - ブラウザ    → セッション Cookie を読む（Discord ログインで発行される）
//   - デスクトップ → `Authorization: Bearer <key>` を customAPIKeyGetter が拾い、
//                    apiKey プラグインが同じ形のセッションに変換して返す
// つまり Hono 側は「セッションか API キーか」を意識しなくてよい。

import { apiKey } from "@better-auth/api-key";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError } from "better-auth/api";
import { createDb } from "../db/client";
import * as schema from "../db/schema";
import { isDiscordUserAllowed } from "./allowlist";

/**
 * 発行する API キーの接頭辞。
 * ログや鍵の一覧で dragonfly の鍵だと見分けるためのもので、認証には一切関与しない。
 * 提示された鍵をこの接頭辞で検査することはしない（サーバーもデスクトップも）。
 */
export const API_KEY_PREFIX = "dfly_";

/**
 * `Authorization: Bearer <key>` から API キーを取り出す。
 *
 * 取り出すだけで、値の中身は一切検証しない。鍵が有効かどうかの判断は
 * better-auth（ハッシュ照合・失効・期限）だけが行う。
 * ここで接頭辞などを見てしまうと検証経路が 2 か所に増え、
 * 「サーバーは弾くがプラグインは通す」ようなズレが生まれるため。
 * Authorization ヘッダが無いリクエスト（Cookie セッション）は null で素通しする。
 */
function apiKeyFromAuthorizationHeader(headers: Headers | undefined): string | null {
  const header = headers?.get("authorization");
  if (!header?.toLowerCase().startsWith("bearer ")) return null;
  const value = header.slice("bearer ".length).trim();
  return value.length > 0 ? value : null;
}

/**
 * better-auth インスタンスを作る。
 * env を引数で受け取る形にしてあるのは、`cloudflare:workers` を import せずに
 * この設定を読み込めるようにするため（CLI やテストから使える）。
 */
export function createAuth(env: Env) {
  const db = createDb(env.DB);

  return betterAuth({
    // Cookie の署名鍵と、リダイレクト URL の組み立てに使う公開 URL。
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL,
    // Hono 側で同じ接頭辞にマウントする。
    basePath: "/api/auth",

    database: drizzleAdapter(db, {
      provider: "sqlite",
      schema,
      // D1 はマルチステートメントのトランザクションを張れないので順次実行にする。
      transaction: false,
    }),

    // メール + パスワードは使わない。ログインは Discord だけ。
    emailAndPassword: { enabled: false },

    socialProviders: {
      discord: {
        clientId: env.DISCORD_CLIENT_ID,
        clientSecret: env.DISCORD_CLIENT_SECRET,
        /**
         * ここがサインイン許可リストの唯一の関門。
         *
         * mapProfileToUser は OAuth コールバックの getUserInfo の中で、
         * かつ user / account 行を書く前に、毎回のサインインで呼ばれる。
         * したがってここで弾けば
         *   - 初回サインインでも user 行が作られない（拒否されたアカウントの痕跡が残らない）
         *   - 一度許可した人を後からリストから外せば、次のサインインで弾ける
         * の両方を満たせる。
         */
        mapProfileToUser: async (profile) => {
          const discordUserId = String(profile.id);
          const allowed = await isDiscordUserAllowed(
            db,
            env.ALLOWED_DISCORD_USER_IDS,
            discordUserId,
          );
          if (!allowed) {
            // この例外は getUserInfo の中から投げられ、better-auth の
            // コールバックルートを抜けて 403 の応答になる（本文に下の code と message が載る）。
            // この時点ではまだ user も account も書いていないので、
            // 拒否されたアカウントの行は一切残らない。
            throw new APIError("FORBIDDEN", {
              code: "DISCORD_USER_NOT_ALLOWED",
              message: "this Discord account is not allowed to sign in to dragonfly",
            });
          }
          // 許可された場合はプロフィールの既定のマッピングをそのまま使う。
          return {};
        },
      },
    },

    plugins: [
      apiKey({
        // 生成される鍵は dfly_ + 64 文字。見分けるための接頭辞で、検証には使わない。
        defaultPrefix: API_KEY_PREFIX,
        // Authorization ヘッダから鍵を拾う。既定の x-api-key は使わない。
        customAPIKeyGetter: (ctx) => apiKeyFromAuthorizationHeader(ctx.headers),
        // 一覧表示用に先頭を保存する。既定の 6 文字だと "dfly_a" のように
        // 接頭辞でほぼ埋まってしまうため、鍵ごとに 8 文字見えるところまで伸ばす。
        startingCharactersConfig: { shouldStore: true, charactersLength: API_KEY_PREFIX.length + 8 },
        // これを立てないと API キーからセッションが組み立てられず、
        // getSession() が Cookie しか見なくなる。
        enableSessionForAPIKeys: true,
      }),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;
