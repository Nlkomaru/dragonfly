// サムネイル(AVIF)から BlurHash を作る、ブラウザ専用の処理。
// アップロード時にデスクトップが計算するようになったが、それより前に上げた写真は
// blurhash を持たないため、AVIF をデコードできるブラウザ側で後から埋める必要がある。
// ハッシュの計算そのものは環境非依存なので @dragonfly/core の encodeBlurhash に任せる。
//
// このモジュールは SSR でも評価されうる（ルートから import されるため）。
// そのため window / document / OffscreenCanvas にはトップレベルで一切触れず、
// 能力判定はすべて関数の呼び出し時に行う（extractPhotoPalette.ts と同じ方針）。
//
// 縮小と描画の手順は extractPhotoPalette.ts とほぼ同じだが、縮小サイズが違う
// （あちらは代表色用の 192px、こちらはぼかし用の 64px）ので、共通化はせず写している。
// あちらは別の関心事（PALETTE_VERSION と対になったサイズ）を持っているため、
// 無理にまとめると片方の都合でもう片方が動くことになる。

import { encodeBlurhash } from "@dragonfly/core";

/**
 * 縮小後の長辺(px)。BlurHash が持つのは数個の低周波成分だけなので、
 * これ以上大きく描いても結果はほとんど変わらず、デコードの時間が伸びるだけ。
 *
 * パレットと違い、サイズが変わっても「比べられなくなる」ことは無い
 * （ハッシュは表示用のプレースホルダにしか使わない）ので、版番号は持たない。
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
    throw new Error("BlurHash の計算はブラウザでのみ実行できます");
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
 * サムネイル画像 1 枚から BlurHash を作る。
 *
 * 失敗時は理由の分かる Error を投げるので、呼び出し側でスキップすること。
 * 1 枚失敗してもプレースホルダが出ないだけなので、画面を止める理由にはならない。
 *
 * @param thumbUrl サムネイル(AVIF)の URL。認証付きの API を叩くので cookie を同送する。
 * @param photoId  エラーメッセージに出す識別子。計算そのものには使わない。
 */
export async function extractPhotoBlurhash(thumbUrl: string, photoId: string): Promise<string> {
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
    // 長さが合わないと encode が投げるので、元サイズではなく描いたサイズを渡す。
    return encodeBlurhash(imageData.data, width, height);
  } finally {
    // ImageBitmap はデコード済みのビットマップを抱えたままなので、成否を問わず解放する。
    bitmap.close();
  }
}
