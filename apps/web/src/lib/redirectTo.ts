// ログイン後の戻り先（`?redirect=`）の検証。
//
// この値は最終的に better-auth の callbackURL としてリダイレクト先になるため、
// 外部サイトへ飛ばせる（オープンリダイレクト）と踏み台にされる。
// 受け取った値は必ずここを通し、同一オリジンのパスだけを許す。

/** 戻り先が無い / 不正なときの既定値。 */
export const DEFAULT_REDIRECT = "/";

/**
 * `?redirect=` の値を同一オリジンのパスに丸める。
 * 許すのは "/" 始まりのパスのみ。"//example.com"（プロトコル相対 URL）や
 * "https:..." のようなスキーム付きは外部を指せるので既定値に落とす。
 */
export function sanitizeRedirectTo(value: unknown): string {
  if (typeof value !== "string" || value === "") return DEFAULT_REDIRECT;
  if (!value.startsWith("/")) return DEFAULT_REDIRECT;
  // "//host" と "/\host" はどちらもブラウザが外部オリジンとして解釈する。
  if (value.startsWith("//") || value.startsWith("/\\")) return DEFAULT_REDIRECT;
  return value;
}
