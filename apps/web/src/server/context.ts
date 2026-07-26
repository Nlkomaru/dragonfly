// better-auth インスタンスのキャッシュ。
//
// betterAuth() はプラグインの初期化やスキーマの解決を行うため、リクエストごとに作り直すと無駄が多い。
// Worker の isolate が生きている間は同じ env を指すので、env ごとに 1 つだけ作って使い回す。

import type { Auth } from "./auth";
import { createAuth } from "./auth";

let cached: { env: Env; auth: Auth } | null = null;

/** この env に対応する better-auth インスタンスを返す。 */
export function getAuth(env: Env): Auth {
  // env の同一性で判定する。dev で env が差し替わっても取り違えない。
  if (cached && cached.env === env) return cached.auth;
  const auth = createAuth(env);
  cached = { env, auth };
  return auth;
}
