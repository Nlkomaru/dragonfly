// 距離行列の計算を Web Worker に投げるためのラッパ。
//
// このモジュールは SSR でも評価されうる（ルートから import されるため）。
// Worker の生成は必ず関数の呼び出し時に行い、トップレベルでは self / Worker に触れない。

import type { DistanceMatrix, PaletteWeighting, PhotoPalette } from "@dragonfly/core";
import { buildDistanceMatrix, reshapeDistanceMatrix } from "@dragonfly/core";
import type { DistanceMatrixRequest, DistanceMatrixResponse } from "./distanceMatrixWorker";

/** 応答と要求を対応付ける連番。同時に 1 本しか投げないが、取り違えないための保険。 */
let nextRequestId = 1;

/**
 * 距離行列を Worker で作る。
 *
 * Worker を使えない環境（古いブラウザや、何らかの理由で生成に失敗した場合）は
 * メインスレッドの同期版に落ちる。計算結果はどちらでも同じ。
 *
 * @param signal 画面を離れたときに計算を捨てるための AbortSignal。
 *               中断すると AbortError を投げ、Worker も即座に終了させる。
 */
export function buildDistanceMatrixAsync(
  palettes: PhotoPalette[],
  weighting: PaletteWeighting,
  signal?: AbortSignal,
): Promise<DistanceMatrix> {
  // 空なら Worker を起こす意味がない。
  if (palettes.length === 0) return Promise.resolve([]);

  let worker: Worker;
  try {
    // new URL(..., import.meta.url) の形は Vite が静的に解決して Worker を別チャンクに出す。
    // 変数に組み立てると解決されなくなるので、この書き方を崩さないこと。
    worker = new Worker(new URL("./distanceMatrixWorker.ts", import.meta.url), {
      type: "module",
    });
  } catch {
    // Worker が作れない環境ではメインスレッドで計算する（枚数が多いと固まるが、動かないよりはよい）。
    return Promise.resolve(buildDistanceMatrix(palettes, weighting));
  }

  return new Promise<DistanceMatrix>((resolve, reject) => {
    const id = nextRequestId++;

    // 解決・失敗・中断のどの経路でも Worker と listener を必ず片付ける。
    const cleanup = () => {
      worker.removeEventListener("message", onMessage);
      worker.removeEventListener("error", onError);
      signal?.removeEventListener("abort", onAbort);
      worker.terminate();
    };

    const onMessage = (event: MessageEvent<DistanceMatrixResponse>) => {
      if (event.data.id !== id) return;
      cleanup();
      if (!event.data.ok) {
        reject(new Error(`距離行列の計算に失敗しました: ${event.data.message}`));
        return;
      }
      // subarray のビューに開くだけなので、ここでのコピーは発生しない。
      resolve(reshapeDistanceMatrix(event.data.flat, event.data.size));
    };

    const onError = () => {
      cleanup();
      // Worker の読み込み自体に失敗しても new Worker() は投げないので、上の catch では拾えない。
      // 実際にはこちらの方が起きやすいため、同じくメインスレッドの同期版に落とす。
      resolve(buildDistanceMatrix(palettes, weighting));
    };

    const onAbort = () => {
      cleanup();
      reject(new DOMException("aborted", "AbortError"));
    };

    if (signal?.aborted) {
      onAbort();
      return;
    }

    worker.addEventListener("message", onMessage);
    worker.addEventListener("error", onError);
    signal?.addEventListener("abort", onAbort);

    worker.postMessage({ id, palettes, weighting } satisfies DistanceMatrixRequest);
  });
}
