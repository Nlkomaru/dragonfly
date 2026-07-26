// wrangler types が生成する worker-configuration.d.ts はバインディング (DB / PHOTOS) しか知らない。
// Secrets と vars は生成物に載らないため、ここで宣言のマージによって Env に足しておく。
//
// 値そのものはリポジトリには置かない。設定方法は docs/web-deploy.md を参照。

interface __DragonflyEnv {
  /** Discord OAuth アプリのクライアント ID（vars でよい。機密ではない）。 */
  DISCORD_CLIENT_ID: string;
  /** Discord OAuth アプリのクライアントシークレット（必ず secret として設定する）。 */
  DISCORD_CLIENT_SECRET: string;
  /** better-auth がセッション Cookie の署名などに使う鍵（必ず secret）。 */
  BETTER_AUTH_SECRET: string;
  /** better-auth が絶対 URL を組み立てるための公開 URL。例: https://dragonfly.vrc.nikomaru.dev */
  BETTER_AUTH_URL: string;
  /**
   * サインインを許可する Discord ユーザー ID のカンマ区切り。
   * allowed_discord_users テーブルがまだ空の初回サインイン用の抜け道で、
   * テーブルの内容との「和」が許可リストになる。省略可。
   */
  ALLOWED_DISCORD_USER_IDS?: string;
}

declare namespace Cloudflare {
  interface Env extends __DragonflyEnv {}
}

interface Env extends __DragonflyEnv {}
