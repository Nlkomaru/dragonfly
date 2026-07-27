// 写真画像 URL の HMAC 署名。
//
// ブラウザの <img src> は Authorization ヘッダを付けないため、画像配信だけは
// クエリの短い署名で認可する。秘密鍵は BETTER_AUTH_SECRET を流用する
//（新しい secret は増やさない）。
//
// 署名対象: `v1:{ownerId}:{photoId}:{variant}:{exp}`
// 署名値:   base64url(HMAC-SHA256(secret, payload))

/** 署名付き URL の既定 TTL（6 時間）。 */
export const PHOTO_URL_TTL_SECONDS = 6 * 60 * 60;

export type PhotoUrlVariant = "image" | "thumb";

/** 秘密文字列ごとに CryptoKey をキャッシュして、毎回の importKey を避ける。 */
const hmacKeyCache = new Map<string, Promise<CryptoKey>>();

/**
 * 現在時刻から TTL を足した有効期限（unix seconds）。
 * テストから時刻を固定できるよう nowSeconds を受け取れる。
 */
export function photoUrlExpiry(nowSeconds: number = Math.floor(Date.now() / 1000)): number {
  return nowSeconds + PHOTO_URL_TTL_SECONDS;
}

/** HMAC の入力文字列。フィールド区切りは `:` 固定。 */
export function photoUrlPayload(
  ownerId: string,
  photoId: string,
  variant: PhotoUrlVariant,
  exp: number,
): string {
  return `v1:${ownerId}:${photoId}:${variant}:${exp}`;
}

/** secret 文字列から HMAC-SHA256 用の CryptoKey を取る（メモ化付き）。 */
function getHmacKey(secret: string): Promise<CryptoKey> {
  let cached = hmacKeyCache.get(secret);
  if (!cached) {
    // Web Crypto のみ使う（Workers / ブラウザ両対応。Node 固有 API は避ける）。
    cached = crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign", "verify"],
    );
    hmacKeyCache.set(secret, cached);
  }
  return cached;
}

/** ArrayBuffer を base64url（パディング無し）へ。 */
function bytesToBase64Url(bytes: ArrayBuffer): string {
  const bin = String.fromCharCode(...new Uint8Array(bytes));
  // btoa は標準 base64 なので、URL 安全形に直してパディングを落とす。
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

/** base64url を Uint8Array に戻す。不正なら null。 */
function base64UrlToBytes(value: string): Uint8Array | null {
  // 空や明らかに壊れた値は早めに落とす。
  if (!value || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const padLen = (4 - (padded.length % 4)) % 4;
  try {
    const bin = atob(padded + "=".repeat(padLen));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/** payload に HMAC-SHA256 を掛け、base64url の署名文字列を返す。 */
export async function signPhotoPayload(secret: string, payload: string): Promise<string> {
  const key = await getHmacKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return bytesToBase64Url(sig);
}

/**
 * 画像 / サムネ用の相対パス付き署名 URL を組み立てる。
 * ownerId は必ず実 ID（`me` は書かない）。共有やキャッシュに持ち出す前提。
 */
export async function buildSignedPhotoUrl(
  secret: string,
  ownerId: string,
  photoId: string,
  variant: PhotoUrlVariant,
  exp: number = photoUrlExpiry(),
): Promise<string> {
  const payload = photoUrlPayload(ownerId, photoId, variant, exp);
  const sig = await signPhotoPayload(secret, payload);
  return `/api/v1/users/${ownerId}/photos/${photoId}/${variant}?exp=${exp}&sig=${sig}`;
}

export type VerifySignedPhotoResult =
  | { ok: true; exp: number }
  | { ok: false; reason: "missing" | "malformed" | "expired" | "mismatch" };

/**
 * クエリの exp / sig を検証する。
 * - exp は unix seconds の整数文字列
 * - sig は payload の HMAC
 * - 期限切れ・改ざん・欠落はすべて ok: false（理由だけ分ける）
 */
export async function verifySignedPhotoUrl(input: {
  secret: string;
  ownerId: string;
  photoId: string;
  variant: PhotoUrlVariant;
  exp: string | null | undefined;
  sig: string | null | undefined;
  nowSeconds?: number;
}): Promise<VerifySignedPhotoResult> {
  const { secret, ownerId, photoId, variant, exp: expRaw, sig } = input;
  // どちらか欠けていれば「署名パスではない」。
  if (expRaw == null || expRaw === "" || sig == null || sig === "") {
    return { ok: false, reason: "missing" };
  }

  // 数字以外や小数は不正。先頭ゼロ付きも Number 経由で正規化する。
  if (!/^[0-9]+$/.test(expRaw)) {
    return { ok: false, reason: "malformed" };
  }
  const exp = Number(expRaw);
  if (!Number.isSafeInteger(exp) || exp <= 0) {
    return { ok: false, reason: "malformed" };
  }

  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (exp < now) {
    return { ok: false, reason: "expired" };
  }

  const sigBytes = base64UrlToBytes(sig);
  if (!sigBytes) {
    return { ok: false, reason: "malformed" };
  }

  const payload = photoUrlPayload(ownerId, photoId, variant, exp);
  const key = await getHmacKey(secret);
  // subtle.verify は定数時間比較相当。自前の === 比較は使わない。
  // TS の ArrayBufferLike と BufferSource の差を吸収するため、中身をコピーして渡す。
  const sigCopy = new Uint8Array(sigBytes.byteLength);
  sigCopy.set(sigBytes);
  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    sigCopy,
    new TextEncoder().encode(payload),
  );
  if (!valid) {
    return { ok: false, reason: "mismatch" };
  }
  return { ok: true, exp };
}
