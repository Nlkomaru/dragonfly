// サムネイル(AVIF)から代表色パレットを取り出す、ブラウザ専用の処理。
// jimp などの Node 向けデコーダは AVIF を読めないため、ブラウザの画像デコーダ
// (createImageBitmap) にデコードさせ、canvas 経由で RGBA を取り出す。
// 色の計算そのものは環境非依存なので @dragonfly/core の extractPalette に任せる。
//
// このモジュールは SSR でも評価されうる（ルートから import されるため）。
// そのため window / document / OffscreenCanvas にはトップレベルで一切触れず、
// 能力判定はすべて関数の呼び出し時に行う。

import type { PaletteSwatch } from "@dragonfly/core";
import { extractPalette } from "@dragonfly/core";

/**
 * 縮小後の長辺(px)。代表色を取るだけなら細部は不要で、
 * 64px なら 1 枚あたり高々 4096 画素なので k-means が一瞬で終わる。
 *
 * この値は PALETTE_VERSION と対になっている。縮小サイズが変わると同じ写真でも
 * 代表色がずれ、別のサイズで抽出したパレットとは距離を比べられなくなる。
 * 変えるときは必ず @dragonfly/core の PALETTE_VERSION を上げ、再抽出させること。
 */
const SAMPLE_MAX_EDGE = 64;

/** 元サイズから、長辺が SAMPLE_MAX_EDGE 以下になる描画サイズを求める。最低 1px は確保する。 */
function fitToSampleSize(width: number, height: number): { width: number; height: number } {
  const longest = Math.max(width, height);
  // 元から小さい画像を引き伸ばしても情報は増えないので、縮小方向にだけ効かせる。
  const scale = longest > SAMPLE_MAX_EDGE ? SAMPLE_MAX_EDGE / longest : 1;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/**
 * ImageBitmap を指定サイズで描画して RGBA を取り出す。
 * OffscreenCanvas の有無による差はこの関数の中で閉じ、呼び出し側には ImageData だけ渡す。
 * 能力判定を関数内で行うのは、SSR 時の判定結果がモジュールに焼き付くのを避けるため。
 */
function drawToImageData(bitmap: ImageBitmap, width: number, height: number): ImageData {
  // どちらの分岐でも getImageData を 1 回呼ぶだけなので、willReadFrequently を立てて
  // GPU 側テクスチャではなく CPU 側のバッファに描かせる（読み戻しの警告と待ちを避ける）。
  // 設定オブジェクトは canvas の種類ごとに型が違うため、共有せず各分岐で直接渡す。

  if (typeof OffscreenCanvas !== "undefined") {
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("2D コンテキストを取得できませんでした (OffscreenCanvas)");
    context.drawImage(bitmap, 0, 0, width, height);
    return context.getImageData(0, 0, width, height);
  }

  if (typeof document === "undefined") {
    throw new Error("パレット抽出はブラウザでのみ実行できます");
  }

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("2D コンテキストを取得できませんでした (HTMLCanvasElement)");
  context.drawImage(bitmap, 0, 0, width, height);
  return context.getImageData(0, 0, width, height);
}

/**
 * サムネイル画像 1 枚から代表色パレット（PALETTE_SIZE 色）を抽出する。
 *
 * seed に photoId を渡すため、同じ写真からは常に同じパレットが得られる。
 * 失敗時は理由の分かる Error を投げるので、呼び出し側でスキップするか通知すること。
 *
 * @param thumbUrl サムネイル(AVIF)の URL。認証付きの API を叩くので cookie を同送する。
 * @param photoId k-means の乱数シード兼、結果の紐付け先。
 */
export async function extractPhotoPalette(
  thumbUrl: string,
  photoId: string,
): Promise<PaletteSwatch[]> {
  let response: Response;
  try {
    response = await fetch(thumbUrl, { credentials: "include" });
  } catch (cause) {
    throw new Error(`サムネイルを取得できませんでした (${photoId})`, { cause });
  }
  if (!response.ok) {
    throw new Error(`サムネイルの取得に失敗しました (${photoId}): HTTP ${response.status}`);
  }

  const blob = await response.blob();

  let bitmap: ImageBitmap;
  try {
    // AVIF のデコードはここでブラウザに任せる。非対応形式なら例外になる。
    bitmap = await createImageBitmap(blob);
  } catch (cause) {
    throw new Error(`サムネイルをデコードできませんでした (${photoId})`, { cause });
  }

  try {
    const { width, height } = fitToSampleSize(bitmap.width, bitmap.height);
    const imageData = drawToImageData(bitmap, width, height);
    return extractPalette(imageData.data, photoId);
  } finally {
    // ImageBitmap はデコード済みのビットマップを抱えたままなので、成否を問わず解放する。
    bitmap.close();
  }
}

/** mapWithConcurrency の 1 件分の結果。Promise.allSettled と同じ形にして扱い方を揃える。 */
export type SettledResult<R> =
  | { status: "fulfilled"; value: R }
  | { status: "rejected"; reason: unknown };

/**
 * items を最大 limit 並列で処理する。
 *
 * 1 枚のサムネイルが壊れていても残りの抽出を巻き添えにしないよう、
 * 例外は握って per-item の結果として返す（全体は決して reject しない）。
 * 戻り値は **入力と同じ順序** なので、items と添字で対応付けできる。
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<Array<SettledResult<R>>> {
  const results = new Array<SettledResult<R>>(items.length);
  // 複数のワーカーが取り合うカーソル。JS はシングルスレッドなので排他は要らない。
  let cursor = 0;

  async function worker(): Promise<void> {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      try {
        results[index] = { status: "fulfilled", value: await fn(items[index], index) };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  }

  // 並列数は 1 以上、かつ件数を超えても無駄なので上限を items.length に丸める。
  const workerCount = Math.max(1, Math.min(Math.trunc(limit) || 1, items.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  return results;
}
