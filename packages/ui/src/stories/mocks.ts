// Storybook 専用のモックデータ。アプリのバンドルには含めない（index.ts から export しない）。
import type { Photo } from "@dragonfly/core";
import { encodeBlurhash } from "@dragonfly/core";

/** 実在しそうな日本語ワールド名。 */
const WORLDS = [
  { id: "wrld_4cf554b4-430c-4f8f-b53e-1f294eed230b", name: "The Great Pug" },
  { id: "wrld_8f0d7f0e-4f4a-4a5a-9b0e-2a1c8e5d3f61", name: "ゆるふわ喫茶店" },
  { id: "wrld_1b2c3d4e-5f60-4718-8290-abcdef012345", name: "夜明けの海辺" },
  { id: "wrld_9a8b7c6d-5e4f-4302-9182-fedcba987654", name: "宵闇の書斎" },
  { id: "wrld_0f1e2d3c-4b5a-4968-8776-1122334455aa", name: "ネオン街 -Reflection-" },
] as const;

const PLAYERS = [
  { id: "usr_a1b2c3d4-e5f6-4718-8920-1a2b3c4d5e6f", displayName: "しろねこ" },
  { id: "usr_b2c3d4e5-f6a7-4829-9031-2b3c4d5e6f70", displayName: "Yuki_VRC" },
  { id: "usr_c3d4e5f6-a7b8-493a-8142-3c4d5e6f7081", displayName: "みかん大福" },
  { id: "usr_d4e5f6a7-b8c9-4a4b-9253-4d5e6f708192", displayName: "Kanata" },
  { id: "usr_e5f6a7b8-c9da-4b5c-8364-5e6f708192a3", displayName: "そらまめ" },
] as const;

/** 撮影日時の起点（2026-06-01 20:00 ローカル）。乱数を使わず再現可能にする。 */
const BASE_TAKEN_AT = new Date(2026, 5, 1, 20, 0, 0).getTime();

/** `YYYY-MM` を求める（core の toMonthKey と同じ規則）。 */
function monthKeyOf(takenAt: number): string {
  const date = new Date(takenAt);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

/** テスト用の Photo を index から決定的に組み立てる。 */
export function makePhoto(index: number): Photo {
  const world = WORLDS[index % WORLDS.length];
  // 1枚ごとに約 3 時間ずつ遡らせ、数百枚で複数の月にまたがるようにする。
  const takenAt = BASE_TAKEN_AT - index * 3 * 60 * 60 * 1000;
  const date = new Date(takenAt);
  const pad = (value: number) => String(value).padStart(2, "0");
  const fileName = `VRChat_${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}.000_1920x1080.png`;

  return {
    path: `C:\\Users\\niko\\Pictures\\VRChat\\${monthKeyOf(takenAt)}\\${fileName}`,
    fileName,
    takenAt,
    month: monthKeyOf(takenAt),
    width: 1920,
    height: 1080,
    byteSize: 2_400_000 + index * 1_024,
    metadata: {
      application: "VRCX",
      version: 1,
      author: PLAYERS[0],
      world: { ...world, instanceId: `${12345 + index}~friends(${PLAYERS[1].id})~region(jp)` },
      // 同席者は 0〜4 人の範囲で決定的に変える。
      players: PLAYERS.slice(1, 1 + (index % 5)),
    },
    sha256: index % 3 === 0 ? null : `${index}`.padStart(64, "0"),
    // 3枚に1枚は送信済みという想定。
    uploaded: index % 3 === 1,
  };
}

/** n 枚のモック写真を作る。 */
export function makePhotos(count: number): Photo[] {
  return Array.from({ length: count }, (_, index) => makePhoto(index));
}

/** index ごとの色相。サムネイルと BlurHash で同じ色を使うために切り出す。 */
function hueOf(index: number): number {
  return (index * 37) % 360;
}

/**
 * ネットワークに出ないサムネイル代わりの SVG データ URI。
 * index ごとに色相を変えて、グリッドのスクロールが分かるようにする。
 */
export function mockThumbnail(index: number): string {
  const hue = hueOf(index);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="320"><rect width="320" height="320" fill="hsl(${hue} 55% 55%)"/><text x="160" y="176" font-family="sans-serif" font-size="48" fill="rgba(255,255,255,.85)" text-anchor="middle">${index + 1}</text></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

/** HSL（s / l は 0〜1）を 0〜255 の RGB に直す。BlurHash 用の画素を作るだけの簡易版。 */
function hslToRgb(hue: number, saturation: number, lightness: number): [number, number, number] {
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const sector = (((hue % 360) + 360) % 360) / 60;
  const second = chroma * (1 - Math.abs((sector % 2) - 1));
  const [r, g, b] =
    sector < 1
      ? [chroma, second, 0]
      : sector < 2
        ? [second, chroma, 0]
        : sector < 3
          ? [0, chroma, second]
          : sector < 4
            ? [0, second, chroma]
            : sector < 5
              ? [second, 0, chroma]
              : [chroma, 0, second];
  const offset = lightness - chroma / 2;
  return [
    Math.round((r + offset) * 255),
    Math.round((g + offset) * 255),
    Math.round((b + offset) * 255),
  ];
}

/**
 * mockThumbnail と同じ色相の BlurHash。
 *
 * 妥当な文字列を目視で確かめて貼るのではなく、その場で encodeBlurhash に通すことで
 * 「必ず妥当なハッシュである」ことを作り方の側で保証する。
 * 上下で明るさを変えているのは、単色だとぼかしが効いているか分からないため。
 */
export function mockBlurhash(index: number): string {
  const width = 16;
  const height = 16;
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    // 上を明るく、下を暗くする縦のグラデーション。
    const lightness = 0.75 - (y / (height - 1)) * 0.45;
    const [r, g, b] = hslToRgb(hueOf(index), 0.55, lightness);
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      rgba[offset] = r;
      rgba[offset + 1] = g;
      rgba[offset + 2] = b;
      rgba[offset + 3] = 255;
    }
  }
  return encodeBlurhash(rgba, width, height);
}
