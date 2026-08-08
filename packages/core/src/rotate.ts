// RGBA ピクセルバッファの回転。
//
// R2 上の AVIF を「実体ごと」回転させるために使う（DB に回転角は持たない方針）。
// デコード / エンコードは実行環境ごとに手段が違う（Worker は wasm、ブラウザは canvas）ので、
// ここには環境に依存しないピクセル操作だけを置く。

/** 対応する回転角。時計回りの度数で表す。 */
export const ROTATION_DEGREES = [90, 180, 270] as const;

export type RotationDegrees = (typeof ROTATION_DEGREES)[number];

/** デコード済みの RGBA 画像。ImageData と互換の形（DOM には依存しない）。 */
export interface RgbaImage {
  /** RGBA の順で 1 ピクセル 4 バイト。長さは width * height * 4。 */
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

/**
 * RGBA バッファを時計回りに回転した新しい画像を返す。入力は変更しない。
 *
 * 添字の対応（いずれも時計回り、src は W×H）:
 * -  90°: (x, y) → (H-1-y, x)         出力は H×W
 * - 180°: (x, y) → (W-1-x, H-1-y)     出力は W×H
 * - 270°: (x, y) → (y, W-1-x)         出力は H×W
 */
export function rotateRgba(image: RgbaImage, degrees: RotationDegrees): RgbaImage {
  const { data, width, height } = image;
  if (data.length !== width * height * 4) {
    throw new Error(`invalid RGBA buffer: expected ${width * height * 4} bytes, got ${data.length}`);
  }

  const out = new Uint8ClampedArray(data.length);
  const [outWidth, outHeight] = degrees === 180 ? [width, height] : [height, width];

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const src = (y * width + x) * 4;
      // 回転後の座標。degrees ごとの対応は上のコメントの通り。
      let dstX: number;
      let dstY: number;
      if (degrees === 90) {
        dstX = height - 1 - y;
        dstY = x;
      } else if (degrees === 180) {
        dstX = width - 1 - x;
        dstY = height - 1 - y;
      } else {
        dstX = y;
        dstY = width - 1 - x;
      }
      const dst = (dstY * outWidth + dstX) * 4;
      out[dst] = data[src];
      out[dst + 1] = data[src + 1];
      out[dst + 2] = data[src + 2];
      out[dst + 3] = data[src + 3];
    }
  }

  return { data: out, width: outWidth, height: outHeight };
}
