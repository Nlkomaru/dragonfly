import { describe, expect, it } from "vitest";
import {
  BLURHASH_COMPONENTS_X,
  BLURHASH_COMPONENTS_Y,
  decodeBlurhashToRgba,
  encodeBlurhash,
  isValidBlurhash,
} from "./blurhash";

/** テスト用に単色 RGBA の画素列を作る。 */
function solid(r: number, g: number, b: number, width: number, height: number): Uint8ClampedArray {
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    pixels.set([r, g, b, 255], i * 4);
  }
  return pixels;
}

describe("blurhash", () => {
  it("encodes RGBA pixels into a valid hash", () => {
    const hash = encodeBlurhash(solid(60, 120, 200, 8, 8), 8, 8);
    expect(isValidBlurhash(hash)).toBe(true);
    // 長さは成分数だけで決まる。Rust 側と成分数がずれていないかの目印にもなる。
    expect(hash).toHaveLength(6 + 2 * (BLURHASH_COMPONENTS_X * BLURHASH_COMPONENTS_Y - 1));
  });

  it("decodes a hash back into an RGBA buffer of the requested size", () => {
    const hash = encodeBlurhash(solid(60, 120, 200, 8, 8), 8, 8);
    const rgba = decodeBlurhashToRgba(hash, 32, 32);
    expect(rgba).toHaveLength(32 * 32 * 4);
    // 単色を焼いたので、復元しても元の色に近いはず（低周波成分だけなので厳密には一致しない）。
    expect(rgba[0]).toBeGreaterThan(20);
    expect(rgba[2]).toBeGreaterThan(rgba[0]);
  });

  it("rejects strings that are not blurhashes", () => {
    expect(isValidBlurhash("")).toBe(false);
    expect(isValidBlurhash("not-a-blurhash")).toBe(false);
  });

  it("rejects pixel buffers whose length does not match the size", () => {
    expect(() => encodeBlurhash(solid(0, 0, 0, 8, 8), 16, 16)).toThrow();
  });
});
