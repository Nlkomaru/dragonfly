// 走査・ハッシュ計算・送信済み判定・アップロードという一連の流れを、
// Rust 側のコマンドとイベントに繋ぐフック。画面はこのフックだけを見ればよい。

import { useCallback, useEffect } from "react";
import { useAtom, useSetAtom } from "jotai";
import { call } from "@dragonfly/api-client";
import type { Photo, ScanResult } from "@dragonfly/core";
import {
  clearSelectionAtom,
  photosAtom,
  scanningAtom,
  selectedPathsAtom,
  skippedCountAtom,
} from "../state/photos";

/** Rust の `hash_photos` が返す1件分。 */
interface PhotoHash {
  path: string;
  sha256: string;
}

export function usePhotoLibrary() {
  const [photos, setPhotos] = useAtom(photosAtom);
  const [scanning, setScanning] = useAtom(scanningAtom);
  const setSkipped = useSetAtom(skippedCountAtom);
  const [selectedPaths] = useAtom(selectedPathsAtom);
  const clearSelection = useSetAtom(clearSelectionAtom);

  /** スクリーンショットを走査し直す。メタデータの無いものは Rust 側で除外済み。 */
  const scan = useCallback(async () => {
    setScanning(true);
    try {
      const result = await call<ScanResult>("scan_photos");
      setPhotos(result.photos);
      setSkipped(result.skippedCount);
      // 走査直後にハッシュを計算し、続けて送信済みかを一括で問い合わせる。
      await refreshUploadState(result.photos, setPhotos);
    } finally {
      setScanning(false);
    }
  }, [setPhotos, setScanning, setSkipped]);

  /** 選択中の写真を AVIF に変換して送る。送信済みのものは Rust 側で除外される。 */
  const upload = useCallback(async () => {
    const paths = [...selectedPaths];
    if (paths.length === 0) return;
    await call<void>("upload_photos", { paths });
    clearSelection();
    await scan();
  }, [selectedPaths, clearSelection, scan]);

  return { photos, scanning, scan, upload };
}

/**
 * 起動時に一度だけ走査する。root と各画面の両方から呼ばれても二重に走らないよう、
 * モジュールスコープのフラグで守る（画面の再マウントでも再走査しない）。
 */
let hasScannedOnce = false;

export function useInitialPhotoScan(): void {
  const { scan } = usePhotoLibrary();

  useEffect(() => {
    if (hasScannedOnce) return;
    hasScannedOnce = true;
    void scan();
  }, [scan]);
}

/** ハッシュを計算し、サーバーに送信済みかを問い合わせて一覧に反映する。 */
async function refreshUploadState(
  photos: Photo[],
  setPhotos: (photos: Photo[]) => void,
): Promise<void> {
  if (photos.length === 0) return;

  const hashes = await call<PhotoHash[]>("hash_photos", {
    paths: photos.map((photo) => photo.path),
  });
  const byPath = new Map(hashes.map((entry) => [entry.path, entry.sha256]));

  // 送信済み判定はハッシュの一括問い合わせ。分割は Rust 側が受け持つ。
  const uploaded = new Set(
    await call<string[]>("check_uploaded", { hashes: hashes.map((entry) => entry.sha256) }),
  );

  setPhotos(
    photos.map((photo) => {
      const sha256 = byPath.get(photo.path) ?? null;
      return { ...photo, sha256, uploaded: sha256 !== null && uploaded.has(sha256) };
    }),
  );
}
