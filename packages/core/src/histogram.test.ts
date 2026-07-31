import { describe, expect, it } from "vitest";
import {
  HISTOGRAM_SIZE,
  buildHistogram,
  buildHistogramMatrixFlat,
  decodeHistogram,
  encodeHistogram,
  groupByTargetSize,
  histogramDistance,
  splitOversizedLabels,
  averageLinkageLabels,
  HISTOGRAM_VERSION,
} from "./histogram";

/** 単色の RGBA を count 画素ぶん作る。 */
function solid(r: number, g: number, b: number, count: number, alpha = 255): Uint8ClampedArray {
  const pixels = new Uint8ClampedArray(count * 4);
  for (let i = 0; i < count; i += 1) {
    pixels[i * 4] = r;
    pixels[i * 4 + 1] = g;
    pixels[i * 4 + 2] = b;
    pixels[i * 4 + 3] = alpha;
  }
  return pixels;
}

/** 2 色を半分ずつ含む RGBA。 */
function twoTone(
  first: [number, number, number],
  second: [number, number, number],
  count: number,
): Uint8ClampedArray {
  const pixels = new Uint8ClampedArray(count * 4);
  for (let i = 0; i < count; i += 1) {
    const [r, g, b] = i < count / 2 ? first : second;
    pixels[i * 4] = r;
    pixels[i * 4 + 1] = g;
    pixels[i * 4 + 2] = b;
    pixels[i * 4 + 3] = 255;
  }
  return pixels;
}

function toHistogram(photoId: string, pixels: Uint8ClampedArray) {
  return { photoId, version: HISTOGRAM_VERSION, bins: buildHistogram(pixels) };
}

describe("buildHistogram", () => {
  it("sums to one and puts a solid colour in a single bin", () => {
    const bins = buildHistogram(solid(220, 30, 40, 100));
    expect(bins.length).toBe(HISTOGRAM_SIZE);
    expect(bins.reduce((acc, x) => acc + x, 0)).toBeCloseTo(1, 12);
    expect(bins.filter((x) => x > 0).length).toBe(1);
  });

  it("ignores transparent pixels", () => {
    const opaque = buildHistogram(solid(10, 120, 200, 50));
    const withTransparent = new Uint8ClampedArray(400);
    withTransparent.set(solid(10, 120, 200, 50));
    // 後ろ半分は alpha 0 のまま（黒・透明）。
    expect(Array.from(buildHistogram(withTransparent))).toEqual(Array.from(opaque));
  });

  it("falls back to a flat histogram when nothing is opaque", () => {
    const bins = buildHistogram(solid(200, 200, 200, 10, 0));
    expect(bins.reduce((acc, x) => acc + x, 0)).toBeCloseTo(1, 12);
    expect(new Set(bins).size).toBe(1);
  });
});

describe("encodeHistogram / decodeHistogram", () => {
  it("round-trips a histogram closely enough to keep distances", () => {
    const bins = buildHistogram(twoTone([230, 40, 40], [20, 30, 210], 200));
    const decoded = decodeHistogram(encodeHistogram(bins));
    expect(decoded).not.toBeNull();
    expect((decoded as Float64Array).reduce((acc, x) => acc + x, 0)).toBeCloseTo(1, 12);
    // 量子化しても距離はほぼ変わらない（実データでもグループ分けの結果は同じだった）。
    expect(histogramDistance(bins, decoded as Float64Array)).toBeLessThan(0.05);
  });

  it("rejects broken input instead of returning a wrong histogram", () => {
    expect(decodeHistogram("")).toBeNull();
    expect(decodeHistogram("!!!!")).toBeNull();
    // 3 バイトの倍数でない
    expect(decodeHistogram(encodeHistogram(buildHistogram(solid(1, 2, 3, 4))).slice(0, 2))).toBeNull();
  });
});

describe("histogramDistance", () => {
  it("is zero for identical photos and larger for different colours", () => {
    const red = buildHistogram(solid(220, 30, 40, 100));
    const red2 = buildHistogram(solid(215, 35, 45, 100));
    const blue = buildHistogram(solid(20, 30, 210, 100));
    expect(histogramDistance(red, red)).toBe(0);
    expect(histogramDistance(red, red2)).toBeLessThan(histogramDistance(red, blue));
    // Hellinger 距離の上限は sqrt(2)。
    expect(histogramDistance(red, blue)).toBeLessThanOrEqual(Math.SQRT2 + 1e-9);
  });

  it("builds a symmetric matrix with a zero diagonal", () => {
    const histograms = [
      toHistogram("a", solid(220, 30, 40, 60)),
      toHistogram("b", solid(20, 30, 210, 60)),
      toHistogram("c", twoTone([220, 30, 40], [20, 30, 210], 60)),
    ];
    const n = histograms.length;
    const flat = buildHistogramMatrixFlat(histograms);
    for (let i = 0; i < n; i += 1) {
      expect(flat[i * n + i]).toBe(0);
      for (let j = 0; j < n; j += 1) {
        expect(flat[i * n + j]).toBeCloseTo(flat[j * n + i], 12);
        expect(flat[i * n + j]).toBeGreaterThanOrEqual(0);
      }
    }
    // 混色は両方の単色より、互いの単色同士より近い。
    expect(flat[0 * n + 2]).toBeLessThan(flat[0 * n + 1]);
  });
});

describe("averageLinkageLabels", () => {
  it("puts the two close items together and separates the far one", () => {
    // a と b が近く、c だけ遠い。
    const matrix = [
      [0, 0.1, 1.0],
      [0.1, 0, 1.0],
      [1.0, 1.0, 0],
    ];
    const labels = averageLinkageLabels(matrix, 2, 3);
    expect(labels[0]).toBe(labels[1]);
    expect(labels[2]).not.toBe(labels[0]);
  });

  it("returns one label per item and never more groups than asked", () => {
    const matrix = Array.from({ length: 6 }, (_, i) =>
      Array.from({ length: 6 }, (_, j) => Math.abs(i - j) / 10),
    );
    const labels = averageLinkageLabels(matrix, 3, 6);
    expect(labels.length).toBe(6);
    expect(new Set(labels).size).toBe(3);
  });
});

describe("splitOversizedLabels", () => {
  it("splits a group that exceeds the limit and leaves small ones alone", () => {
    const matrix = Array.from({ length: 6 }, (_, i) =>
      Array.from({ length: 6 }, (_, j) => Math.abs(i - j) / 10),
    );
    // 全部が 1 つの組。目標 2 枚、上限 2 倍 = 4 枚。
    const labels = splitOversizedLabels(matrix, new Int32Array(6), 2, 2);
    const sizes = new Map<number, number>();
    for (const label of labels) sizes.set(label, (sizes.get(label) ?? 0) + 1);
    expect(Math.max(...sizes.values())).toBeLessThanOrEqual(4);
    expect(labels.length).toBe(6);
  });
});

describe("groupByTargetSize", () => {
  it("covers every photo exactly once and keeps groups near the target", () => {
    const items = Array.from({ length: 12 }, (_, i) => ({ photoId: `p${i}` }));
    const matrix = Array.from({ length: 12 }, (_, i) =>
      Array.from({ length: 12 }, (_, j) => Math.abs(i - j) / 12),
    );
    const groups = groupByTargetSize(items, matrix, 3);
    const flat = groups.flat();
    expect(flat.length).toBe(12);
    expect(new Set(flat).size).toBe(12);
    // 目標 3 枚なので、上限は 2 倍の 6 枚。
    expect(Math.max(...groups.map((g) => g.length))).toBeLessThanOrEqual(6);
    // 並びは大きい順。
    expect([...groups].sort((a, b) => b.length - a.length).map((g) => g.length)).toEqual(
      groups.map((g) => g.length),
    );
  });

  it("is deterministic", () => {
    const items = Array.from({ length: 8 }, (_, i) => ({ photoId: `p${i}` }));
    const matrix = Array.from({ length: 8 }, (_, i) =>
      Array.from({ length: 8 }, (_, j) => Math.abs(Math.sin(i) - Math.sin(j))),
    );
    expect(groupByTargetSize(items, matrix, 2)).toEqual(groupByTargetSize(items, matrix, 2));
  });

  it("returns an empty list for no photos", () => {
    expect(groupByTargetSize([], [], 5)).toEqual([]);
  });
});
