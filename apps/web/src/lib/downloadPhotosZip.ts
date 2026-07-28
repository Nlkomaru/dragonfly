// 写真をまとめて ZIP で保存する、ブラウザ専用の処理。
//
// 落とすのはサムネイルではなく画像の本体 (ApiPhoto.url)。
// 中身は AVIF で既に圧縮済みなので、ZIP 側では圧縮せずに束ねるだけにしている
// （@dragonfly/core の buildStoredZip）。
//
// このモジュールは SSR でも評価されうるため、トップレベルで document / URL に触れない。

import type { ApiPhoto } from "@dragonfly/core";
import { buildStoredZip, type ZipEntry } from "@dragonfly/core";
import { mapWithConcurrency } from "./extractPhotoPalette";

/** 画像本体の取得の同時実行数。サムネイルより 1 枚が重いので控えめにする。 */
const FETCH_CONCURRENCY = 4;

/**
 * 1 つの ZIP に入れる枚数の上限。
 *
 * ZIP はいったん全部メモリに載せてから書き出すため、際限なく増やすとタブが落ちる。
 * 1 枚 1〜2MB として、この枚数でおよそ数百 MB に収まる。
 */
export const ZIP_MAX_PHOTOS = 500;

/** 進捗の通知。取得できた枚数と全体の枚数を渡す。 */
export type ZipProgress = (done: number, total: number) => void;

/** unix ミリ秒を `2026-05-27_03-31-44` の形にする。ローカルタイムで読む。 */
function formatTakenAt(takenAt: number): string {
  const d = new Date(takenAt);
  if (Number.isNaN(d.getTime())) return "unknown";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

/**
 * 書庫内でのファイル名を作る。
 *
 * ワールド名は使わない。ZIP のファイル名を UTF-8 として正しく書いても、
 * 展開ツールによっては解釈されず文字化けするため、ASCII だけで組み立てる。
 * 撮影日時が同じ写真があっても衝突しないよう、末尾に写真 ID を入れる。
 */
function entryName(photo: ApiPhoto): string {
  return `VRChat_${formatTakenAt(photo.takenAt)}_${photo.id}.avif`;
}

/**
 * 写真をまとめて ZIP にし、ブラウザのダウンロードとして保存させる。
 *
 * 1 枚でも取得に失敗したら、その写真だけを飛ばして残りを保存する
 * （全部落ちるより、取れた分を渡す方が実用的なため）。飛ばした枚数を返す。
 *
 * @throws 枚数が ZIP_MAX_PHOTOS を超える場合、1 枚も取得できなかった場合。
 */
export async function downloadPhotosZip(
  photos: ApiPhoto[],
  fileName: string,
  onProgress?: ZipProgress,
  signal?: AbortSignal,
): Promise<{ skipped: number }> {
  if (photos.length === 0) throw new Error("保存する写真がありません");
  if (photos.length > ZIP_MAX_PHOTOS) {
    throw new Error(`一度に保存できるのは ${ZIP_MAX_PHOTOS} 枚までです（${photos.length} 枚）`);
  }

  let done = 0;
  const results = await mapWithConcurrency(
    photos,
    FETCH_CONCURRENCY,
    async (photo): Promise<ZipEntry> => {
      if (signal?.aborted) throw new Error("cancelled");
      const res = await fetch(photo.url, { credentials: "include", signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = new Uint8Array(await res.arrayBuffer());
      done += 1;
      onProgress?.(done, photos.length);
      return { name: entryName(photo), data, date: new Date(photo.takenAt) };
    },
  );

  if (signal?.aborted) throw new Error("cancelled");

  const entries: ZipEntry[] = [];
  let skipped = 0;
  for (const result of results) {
    if (result.status === "fulfilled") entries.push(result.value);
    else skipped += 1;
  }
  if (entries.length === 0) throw new Error("写真を 1 枚も取得できませんでした");

  const zip = buildStoredZip(entries);
  // Blob は ArrayBuffer を要求する。Uint8Array のビューをそのまま渡すと型が合わない。
  const blob = new Blob([zip.buffer as ArrayBuffer], { type: "application/zip" });
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = fileName;
    anchor.click();
  } finally {
    // click() は同期でダウンロードを開始するので、直後に解放してよい。
    URL.revokeObjectURL(url);
  }

  return { skipped };
}
