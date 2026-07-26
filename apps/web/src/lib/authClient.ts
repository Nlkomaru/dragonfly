// ブラウザ側の better-auth クライアント。
// 画面からは必ずこれを経由し、/api/auth への fetch を直接書かない。

import { apiKeyClient } from "@better-auth/api-key/client";
import { createAuthClient } from "better-auth/react";

export const authClient = createAuthClient({
  // Worker が SSR と API の両方を持つので、同一オリジンの相対パスでよい。
  basePath: "/api/auth",
  plugins: [apiKeyClient()],
});

export const { useSession, signIn, signOut } = authClient;

/** Discord のログイン画面へ送る。戻り先は API キーの設定画面。 */
export function signInWithDiscord(callbackURL = "/settings/keys") {
  return authClient.signIn.social({ provider: "discord", callbackURL });
}
