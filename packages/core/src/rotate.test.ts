import { describe, expect, it } from "vitest";
import { rotateRgba, type RgbaImage } from "./rotate";

/** 各ピクセルを R 値だけで区別できる 2×3 の画像を作る（G/B/A は添字の検算用）。 */
function makeImage(): RgbaImage {
  // R 値の並び（width=2, height=3）:
  //   0 1
  //   2 3
  //   4 5
  const data = new Uint8ClampedArray(2 * 3 * 4);
  for (let i = 0; i < 6; i++) {
    data[i * 4] = i;
    data[i * 4 + 1] = 100 + i;
    data[i * 4 + 2] = 200 + i;
    data[i * 4 + 3] = 255;
  }
  return { data, width: 2, height: 3 };
}

/** R チャンネルだけを行ごとの二次元配列に取り出す。 */
function redChannel(image: RgbaImage): number[][] {
  const rows: number[][] = [];
  for (let y = 0; y < image.height; y++) {
    const row: number[] = [];
    for (let x = 0; x < image.width; x++) row.push(image.data[(y * image.width + x) * 4]);
    rows.push(row);
  }
  return rows;
}

describe("rotateRgba", () => {
  it("rotates 90 degrees clockwise", () => {
    const rotated = rotateRgba(makeImage(), 90);
    expect(rotated.width).toBe(3);
    expect(rotated.height).toBe(2);
    expect(redChannel(rotated)).toEqual([
      [4, 2, 0],
      [5, 3, 1],
    ]);
  });

  it("rotates 180 degrees", () => {
    const rotated = rotateRgba(makeImage(), 180);
    expect(rotated.width).toBe(2);
    expect(rotated.height).toBe(3);
    expect(redChannel(rotated)).toEqual([
      [5, 4],
      [3, 2],
      [1, 0],
    ]);
  });

  it("rotates 270 degrees clockwise", () => {
    const rotated = rotateRgba(makeImage(), 270);
    expect(redChannel(rotated)).toEqual([
      [1, 3, 5],
      [0, 2, 4],
    ]);
  });

  it("keeps all RGBA channels together", () => {
    const rotated = rotateRgba(makeImage(), 90);
    // 90 度回転後の左上は元の左下 (R=4)。他チャンネルも同じピクセルのまま動く。
    expect(Array.from(rotated.data.slice(0, 4))).toEqual([4, 104, 204, 255]);
  });

  it("90 + 90 equals 180", () => {
    const twice = rotateRgba(rotateRgba(makeImage(), 90), 90);
    expect(twice).toEqual(rotateRgba(makeImage(), 180));
  });

  it("rejects a buffer whose size does not match", () => {
    expect(() =>
      rotateRgba({ data: new Uint8ClampedArray(8), width: 2, height: 3 }, 90),
    ).toThrow(/invalid RGBA buffer/);
  });
});
