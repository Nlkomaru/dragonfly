// 距離行列を作るだけの Web Worker。
//
// buildDistanceMatrixFlat は O(n^2) で、/groups の上限 2000 枚では数秒かかる。
// メインスレッドで回すとその間 UI が完全に固まるため、計算だけをここへ逃がす。
//
// 受け渡しは flat な Float64Array で行う。TypedArray は transfer できるので、
// 4,000,000 要素（2000 枚 = 32MB）でもコピーが発生しない。

import type { PhotoHistogram } from "@dragonfly/core";
import { HISTOGRAM_VERSION, buildHistogramMatrixFlat, decodeHistogram } from "@dragonfly/core";

/**
 * メインスレッドから受け取る要求。id は応答を要求と対応付けるためだけのもの。
 *
 * ヒストグラムは base64 のまま渡す。Float64Array を 2000 個送るより構造化クローンが軽く、
 * デコードは Worker 側で n 回（n^2 ではない）しか走らない。
 */
export type DistanceMatrixRequest = {
  id: number;
  /** photoId と base64 ヒストグラムの組。並び順が距離行列の添字になる。 */
  histograms: { photoId: string; histogram: string }[];
};

/** Worker が返す応答。成功なら flat 行列、失敗なら理由を返す。 */
export type DistanceMatrixResponse =
  | { id: number; ok: true; flat: Float64Array; size: number }
  | { id: number; ok: false; message: string };

/**
 * Worker のグローバルスコープ。
 *
 * tsconfig の lib は DOM なので `self` は Window として型付けされ、transfer 付きの
 * postMessage が通らない。lib に "webworker" を足すと DOM 側の型と衝突するため、
 * このファイルで使う 2 つだけを最小の形で宣言し直す。
 */
const workerScope = self as unknown as {
  addEventListener(
    type: "message",
    listener: (event: MessageEvent<DistanceMatrixRequest>) => void,
  ): void;
  postMessage(message: DistanceMatrixResponse, transfer?: Transferable[]): void;
};

workerScope.addEventListener("message", (event) => {
  const { id, histograms } = event.data;
  try {
    const decoded: PhotoHistogram[] = [];
    for (const entry of histograms) {
      const bins = decodeHistogram(entry.histogram);
      // 壊れた行だけを落とすと添字が呼び出し側とずれるので、ここでは落とさず投げる。
      // 呼び出し側が「ヒストグラムのある写真だけ」を渡す前提。
      if (bins === null) throw new Error(`ヒストグラムを読めませんでした (${entry.photoId})`);
      decoded.push({ photoId: entry.photoId, version: HISTOGRAM_VERSION, bins });
    }
    const flat = buildHistogramMatrixFlat(decoded);
    // バッファごと譲渡する。以後この Worker 側から flat は読めなくなるが、返した時点で用済み。
    workerScope.postMessage({ id, ok: true, flat, size: decoded.length }, [flat.buffer]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    workerScope.postMessage({ id, ok: false, message });
  }
});
