// 生成する主キーの採番と、鍵まわりの小さなユーティリティ。
// Workers 上で動くので Web Crypto (crypto.getRandomValues / crypto.subtle) のみを使う。

const HEX = "0123456789abcdef";

/**
 * UUIDv7 をハイフン付きの正規形で生成する。
 * 先頭 48bit が unix ミリ秒なので、辞書順がおおむね生成順になり、
 * 同一時刻の写真を並べるときの安定した tie-break キーとしても使える。
 */
export function uuidv7(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);

  // 先頭 6 バイトに unix ミリ秒 (48bit) をビッグエンディアンで書く。
  const now = Date.now();
  bytes[0] = (now / 2 ** 40) & 0xff;
  bytes[1] = (now / 2 ** 32) & 0xff;
  bytes[2] = (now / 2 ** 24) & 0xff;
  bytes[3] = (now / 2 ** 16) & 0xff;
  bytes[4] = (now / 2 ** 8) & 0xff;
  bytes[5] = now & 0xff;

  // version = 7、variant = RFC 4122 (10xx)。
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  let hex = "";
  for (const byte of bytes) hex += HEX[byte >> 4] + HEX[byte & 0x0f];
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** API キーの接頭辞。デスクトップ側の入力チェックでも同じ文字列を使う。 */
export const API_KEY_PREFIX = "dfly_";

/**
 * `dfly_` + base62 22 文字の生の鍵を作る。
 * 剰余を取ると分布が偏るため、62 の倍数を超えた値は捨てて引き直す（棄却サンプリング）。
 */
export function generateRawApiKey(): string {
  const chars: string[] = [];
  const buffer = new Uint8Array(32);
  let cursor = buffer.length;
  while (chars.length < 22) {
    if (cursor >= buffer.length) {
      crypto.getRandomValues(buffer);
      cursor = 0;
    }
    const value = buffer[cursor++];
    if (value >= 248) continue; // 248 = 62 * 4。これ以上は偏るので捨てる。
    chars.push(BASE62[value % 62]);
  }
  return API_KEY_PREFIX + chars.join("");
}

/** 生の鍵を SHA-256 の 16 進小文字にする。DB にはこの値しか保存しない。 */
export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  let hex = "";
  for (const byte of new Uint8Array(digest)) hex += HEX[byte >> 4] + HEX[byte & 0x0f];
  return hex;
}
