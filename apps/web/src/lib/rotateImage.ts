// ブラウザで画像を回転し、アップロード用の Blob を作る。
//
// Worker では画像をデコードしない。4K 写真の RGBA バッファを Worker の
// メモリへ展開すると 128 MiB 制限に達するため、ピクセル処理はブラウザで行う。

/** 回転後の画像と、エンコード後の実寸。 */
export interface RotatedImageBlob {
  blob: Blob;
  width: number;
  height: number;
}

/** 回転元画像の取得失敗。404 はサムネイル無しとして扱える。 */
export class ImageFetchError extends Error {
  constructor(
    readonly status: number,
  ) {
    super(`画像を取得できませんでした (${status})`);
  }
}

function canvasToAvif(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(new Error("AVIF のエンコードに失敗しました"));
          return;
        }
        if (blob.type !== "image/avif") {
          reject(new Error("このブラウザは AVIF のエンコードに対応していません"));
          return;
        }
        resolve(blob);
      },
      "image/avif",
      0.7,
    );
  });
}

/** 指定 URL の画像をブラウザで時計回りに回転し、AVIF Blob に変換する。 */
export async function rotateImageBlob(
  sourceUrl: string,
  degrees: 90 | 180 | 270,
): Promise<RotatedImageBlob> {
  const response = await fetch(sourceUrl, { credentials: "include" });
  if (!response.ok) throw new ImageFetchError(response.status);

  const bitmap = await createImageBitmap(await response.blob());
  const width = degrees === 180 ? bitmap.width : bitmap.height;
  const height = degrees === 180 ? bitmap.height : bitmap.width;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;

  const context = canvas.getContext("2d");
  if (!context) {
    bitmap.close();
    throw new Error("画像を回転するキャンバスを作成できませんでした");
  }

  try {
    context.translate(width / 2, height / 2);
    context.rotate((degrees * Math.PI) / 180);
    context.drawImage(bitmap, -bitmap.width / 2, -bitmap.height / 2);
  } finally {
    bitmap.close();
  }

  return { blob: await canvasToAvif(canvas), width, height };
}
