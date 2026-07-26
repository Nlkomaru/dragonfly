// 生成する主キーの採番。Workers 上で動くので Web Crypto のみを使う。
//
// API キーの生成とハッシュ化は better-auth の apiKey プラグインが受け持つため、
// このファイルには残っていない。

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
