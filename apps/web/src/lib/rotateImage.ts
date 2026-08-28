// ブラウザで画像を回転し、アップロード用の Blob を作る。
//
// Worker では画像をデコードしない。4K 写真の RGBA バッファを Worker の
// メモリへ展開すると 128 MiB 制限に達するため、ピクセル処理はブラウザで行う。

import { rotateRgba, type RotationDegrees } from "@dragonfly/core";

/** 回転後の画像と、エンコード後の実寸。 */
export interface RotatedImageBlob {
  blob: Blob;
  width: number;
  height: number;
}

/** 回転元画像の取得失敗。404 はサムネイル無しとして扱える。 */
export class ImageFetchError extends Error {
  constructor(readonly status: number) {
    super(`画像を取得できませんでした (${status})`);
  }
}

/** 指定 URL の画像をブラウザで時計回りに回転し、AVIF Blob に変換する。 */
export async function rotateImageBlob(
  sourceUrl: string,
  degrees: RotationDegrees,
): Promise<RotatedImageBlob> {
  const response = await fetch(sourceUrl, { credentials: "include" });
  if (!response.ok) throw new ImageFetchError(response.status);

  // codec の WASM はブラウザ側だけで遅延ロードする。SSR / Worker には含めない。
  const [{ default: decode }, { default: encode }] = await Promise.all([
    import("@jsquash/avif/decode"),
    import("@jsquash/avif/encode"),
  ]);
  const decoded = await decode(await response.arrayBuffer());
  if (!decoded) throw new Error("AVIF のデコードに失敗しました");
  const rotated = rotateRgba(
    {
      data: decoded.data as Uint8ClampedArray,
      width: decoded.width,
      height: decoded.height,
    },
    degrees,
  );
  const bytes = await encode(
    { data: rotated.data, width: rotated.width, height: rotated.height } as ImageData,
    { quality: 70, speed: 8 },
  );

  return {
    blob: new Blob([bytes], { type: "image/avif" }),
    width: rotated.width,
    height: rotated.height,
  };
}
