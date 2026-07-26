// 設定画面から呼ぶ API キー操作のサーバー関数。
//
// Web 側にはまだログイン (OAuth / セッション) が無いため、暫定ユーザー 1 人に対して操作する。
// 認証が入ったらここでセッションからユーザーを解決する形に差し替える。
// DB アクセスは Bearer 認証の API ルートと同じ db.ts の関数を使い、
// 「所有者を引数で渡す」規約を崩さない。
import { createServerFn } from "@tanstack/react-start";
import { env } from "cloudflare:workers";
import { createApiKey, listApiKeys, revokeApiKey } from "./db";

/** 0002_seed_bootstrap_user.sql が投入する暫定ユーザーの ID。SQL 側と必ず一致させること。 */
export const BOOTSTRAP_USER_ID = "01900000-0000-7000-8000-000000000001";

export const fetchApiKeys = createServerFn({ method: "GET" }).handler(async () =>
  listApiKeys(env.DB, BOOTSTRAP_USER_ID),
);

export const issueApiKey = createServerFn({ method: "POST" })
  .validator((data: { name: string }) => {
    const name = data.name.trim();
    if (!name) throw new Error("名前を入力してください");
    return { name };
  })
  .handler(async ({ data }) => createApiKey(env.DB, BOOTSTRAP_USER_ID, data.name));

export const revokeApiKeyAction = createServerFn({ method: "POST" })
  .validator((data: { id: string }) => data)
  .handler(async ({ data }) => {
    const revoked = await revokeApiKey(env.DB, BOOTSTRAP_USER_ID, data.id);
    return { revoked };
  });
