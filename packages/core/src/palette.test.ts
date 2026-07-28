import { describe, expect, it } from "vitest";
import {
  PALETTE_SIZE,
  buildDistanceMatrix,
  buildDistanceMatrixFlat,
  extractPalette,
  groupByThreshold,
  nearestPhotos,
  oklabToHex,
  paletteDistance,
  reshapeDistanceMatrix,
  srgbToOklab,
  type PhotoPalette,
} from "./palette";

/** テスト用に単色 RGBA の画素列を作る。 */
function solid(r: number, g: number, b: number, count: number): Uint8ClampedArray {
  const pixels = new Uint8ClampedArray(count * 4);
  for (let i = 0; i < count; i += 1) {
    pixels.set([r, g, b, 255], i * 4);
  }
  return pixels;
}

/** 2 色を半分ずつ含む画素列を作る。 */
function twoTone(
  first: [number, number, number],
  second: [number, number, number],
  count: number,
): Uint8ClampedArray {
  const pixels = new Uint8ClampedArray(count * 4);
  for (let i = 0; i < count; i += 1) {
    const color = i < count / 2 ? first : second;
    pixels.set([...color, 255], i * 4);
  }
  return pixels;
}

/** 複数色を等分に含む画素列を作る。貪欲マッチングが実際に分岐するケース用。 */
function multiTone(
  colors: Array<[number, number, number]>,
  count: number,
): Uint8ClampedArray {
  const pixels = new Uint8ClampedArray(count * 4);
  for (let i = 0; i < count; i += 1) {
    const color = colors[Math.floor((i / count) * colors.length)];
    pixels.set([...color, 255], i * 4);
  }
  return pixels;
}

function toPalette(photoId: string, pixels: Uint8ClampedArray): PhotoPalette {
  return { photoId, version: 1, swatches: extractPalette(pixels, photoId) };
}

describe("oklab conversion", () => {
  it("maps white to lightness 1 and grey to neutral chroma", () => {
    const white = srgbToOklab(255, 255, 255);
    expect(white.l).toBeCloseTo(1, 3);
    const grey = srgbToOklab(128, 128, 128);
    expect(grey.a).toBeCloseTo(0, 3);
    expect(grey.b).toBeCloseTo(0, 3);
  });

  it("round-trips through hex", () => {
    for (const [r, g, b] of [
      [255, 0, 0],
      [255, 255, 255],
      [0, 0, 0],
      [16, 64, 220],
    ]) {
      const lab = srgbToOklab(r, g, b);
      const hex = oklabToHex(lab.l, lab.a, lab.b);
      const expected = `#${[r, g, b].map((c) => c.toString(16).padStart(2, "0")).join("")}`;
      expect(hex).toBe(expected);
    }
  });
});

describe("extractPalette", () => {
  it("is deterministic for the same input", () => {
    const pixels = twoTone([200, 30, 40], [20, 60, 190], 200);
    expect(extractPalette(pixels, "photo-1")).toEqual(
      extractPalette(pixels, "photo-1"),
    );
  });

  it("collapses a solid image into a single swatch", () => {
    const swatches = extractPalette(solid(200, 30, 40, 100), "photo-1");
    expect(swatches).toHaveLength(PALETTE_SIZE);
    expect(swatches[0].ratio).toBeCloseTo(1);
    expect(swatches[0].hex).toBe("#c81e28");
    expect(swatches.slice(1).every((s) => s.ratio === 0)).toBe(true);
  });

  it("splits a two-tone image and keeps ratios summing to 1", () => {
    const swatches = extractPalette(twoTone([255, 0, 0], [0, 0, 255], 200), "photo-2");
    expect(swatches[0].ratio).toBeCloseTo(0.5);
    expect(swatches[1].ratio).toBeCloseTo(0.5);
    expect(swatches.reduce((sum, s) => sum + s.ratio, 0)).toBeCloseTo(1);
  });

  it("drops the dark cluster and renormalises the rest", () => {
    // 画面の半分が黒。k=5 のままだと黒が最大の代表色になってしまう。
    const swatches = extractPalette(twoTone([0, 0, 0], [255, 0, 0], 200), "photo-dark");
    expect(swatches.some((s) => s.ratio > 0 && s.hex === "#000000")).toBe(false);
    // 黒を除いた残り（赤）だけで比率を割り直すので、赤が 100% になる。
    expect(swatches[0].hex).toBe("#ff0000");
    expect(swatches[0].ratio).toBeCloseTo(1);
  });

  it("keeps the dark colour when the whole image is dark", () => {
    // 捨てると何も残らない場合は暗部こそがその写真の色なので、落とさない。
    const swatches = extractPalette(solid(10, 10, 12, 100), "photo-night");
    expect(swatches[0].ratio).toBeCloseTo(1);
    expect(swatches[0].l).toBeLessThan(0.3);
  });

  it("ignores transparent pixels", () => {
    const pixels = twoTone([255, 0, 0], [0, 0, 255], 100);
    // 後半（青）を透明にすると、赤だけが残るはず。
    for (let i = 50; i < 100; i += 1) pixels[i * 4 + 3] = 0;
    const swatches = extractPalette(pixels, "photo-3");
    expect(swatches[0].ratio).toBeCloseTo(1);
    expect(swatches[0].hex).toBe("#ff0000");
  });
});

describe("paletteDistance", () => {
  const red = extractPalette(solid(220, 20, 20, 50), "red");
  const red2 = extractPalette(solid(215, 25, 25, 50), "red2");
  const blue = extractPalette(solid(20, 20, 220, 50), "blue");

  it("is zero against itself", () => {
    expect(paletteDistance(red, red)).toBe(0);
  });

  it("is symmetric", () => {
    expect(paletteDistance(red, blue)).toBe(paletteDistance(blue, red));
  });

  it("ranks a similar palette closer than a different one", () => {
    expect(paletteDistance(red, red2)).toBeLessThan(paletteDistance(red, blue));
  });

  // 単色パレットは全 swatch が同じ色なので貪欲マッチングが分岐しない。
  // 対称性の保証（引数順の正規化）を本当に確かめるには色数の違う組が要る。
  it("stays symmetric for multi-colour palettes", () => {
    const p = extractPalette(
      multiTone(
        [
          [240, 30, 20],
          [30, 200, 60],
          [40, 60, 230],
        ],
        300,
      ),
      "multi-a",
    );
    const q = extractPalette(
      multiTone(
        [
          [250, 210, 40],
          [10, 180, 190],
          [130, 40, 200],
          [30, 30, 30],
        ],
        400,
      ),
      "multi-b",
    );
    expect(paletteDistance(p, q)).toBe(paletteDistance(q, p));
    expect(paletteDistance(p, p)).toBe(0);
    expect(paletteDistance(p, q)).toBeGreaterThan(0);
  });
});

describe("grouping", () => {
  const palettes = [
    toPalette("b-red", solid(220, 20, 20, 50)),
    toPalette("a-red", solid(215, 25, 25, 50)),
    toPalette("c-blue", solid(20, 20, 220, 50)),
  ];
  const matrix = buildDistanceMatrix(palettes);

  it("builds a symmetric matrix with a zero diagonal", () => {
    expect(matrix[0][0]).toBe(0);
    expect(matrix[0][2]).toBe(matrix[2][0]);
  });

  it("separates by threshold and merges as it grows", () => {
    // しきい値 0 では誰も繋がらないので 3 グループ。
    expect(groupByThreshold(palettes, matrix, 0)).toHaveLength(3);
    // 赤同士だけが繋がるしきい値では 2 グループ（大きい方が先）。
    const mid = (matrix[0][1] + matrix[0][2]) / 2;
    expect(groupByThreshold(palettes, matrix, mid)).toEqual([
      ["a-red", "b-red"],
      ["c-blue"],
    ]);
    // 十分大きくすれば全部ひとまとまり。
    expect(groupByThreshold(palettes, matrix, 10)).toEqual([
      ["a-red", "b-red", "c-blue"],
    ]);
  });

  it("returns the closest photos excluding itself", () => {
    expect(nearestPhotos(palettes, matrix, "b-red", 1)).toEqual([
      { photoId: "a-red", distance: matrix[0][1] },
    ]);
    expect(nearestPhotos(palettes, matrix, "missing", 3)).toEqual([]);
  });

  // Worker 経路（flat + reshape）と同期経路が同じ結果になることを担保する。
  it("reshaped flat matrix matches the plain one", () => {
    const reshaped = reshapeDistanceMatrix(buildDistanceMatrixFlat(palettes), palettes.length);
    for (let i = 0; i < palettes.length; i += 1) {
      for (let j = 0; j < palettes.length; j += 1) {
        expect(reshaped[i][j]).toBe(matrix[i][j]);
      }
    }
    // 添字の緩い型で受ける関数にも、そのまま渡せること。
    expect(groupByThreshold(palettes, reshaped, 0)).toEqual(groupByThreshold(palettes, matrix, 0));
  });
});
