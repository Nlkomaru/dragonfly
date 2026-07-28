// 走査・ハッシュ計算・送信済み判定・アップロードという一連の流れを、
// Rust 側のコマンドとイベントに繋ぐフック。画面はこのフックだけを見ればよい。

import { useCallback, useEffect } from "react";
import { useAtom, useSetAtom } from "jotai";
import { call, subscribe } from "@dragonfly/api-client";
import type { Photo, ScanResult, UploadProgress, UploadSummary } from "@dragonfly/core";
import {
  applyUploadResultsAtom,
  deselectPathsAtom,
  photosAtom,
  scanningAtom,
  selectedPathsAtom,
  skippedCountAtom,
  uploadCheckStateAtom,
  uploadStateAtom,
  type UploadCheckState,
} from "../state/photos";

/** Rust 側が送信 1 件ごとに発火するイベント名（`uploader.rs` と同じ値）。 */
const UPLOAD_PROGRESS_EVENT = "upload_progress";

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
  const deselect = useSetAtom(deselectPathsAtom);
  const setUploadState = useSetAtom(uploadStateAtom);
  const setUploadCheck = useSetAtom(uploadCheckStateAtom);
  const applyUploadResults = useSetAtom(applyUploadResultsAtom);

  /**
   * スクリーンショットを走査し直す。メタデータの無いものは Rust 側で除外済み。
   *
   * 例外は必ずここで受け止める。呼び出し側が `void scan()` で捨てているため、
   * ここで拾わないと失敗が画面にもコンソールにも残らず、
   * 「一覧は出るのに送信済みが 0 件のまま」という原因不明の状態になる。
   */
  const scan = useCallback(async () => {
    setScanning(true);
    try {
      const result = await call<ScanResult>("scan_photos");
      setPhotos(result.photos);
      setSkipped(result.skippedCount);
      // 走査直後にハッシュを計算し、続けて送信済みかを月ごとに問い合わせる。
      await refreshUploadState(result.photos, setPhotos, setUploadCheck);
    } catch (error) {
      // 月ごとの失敗は refreshUploadState が拾うので、ここに来るのは走査自体の失敗。
      setUploadCheck({
        doneMonths: 0,
        totalMonths: 0,
        currentMonth: "",
        failed: [
          {
            month: "",
            message: error instanceof Error ? error.message : String(error),
          },
        ],
      });
    } finally {
      setScanning(false);
    }
  }, [setPhotos, setScanning, setSkipped, setUploadCheck]);

  /**
   * 選択中の写真を AVIF に変換して送る。
   * 既に送信済みのものを再送しても、サーバーが sourceSha256 で冪等に扱うため行は増えない。
   */
  const upload = useCallback(async () => {
    const paths = [...selectedPaths];
    if (paths.length === 0) return;

    setUploadState({
      processed: 0,
      total: paths.length,
      succeeded: 0,
      failed: 0,
      currentName: "",
      done: false,
    });
    // 1 件終わるごとに Rust から進捗が飛んでくる。呼び出しの間だけ購読する。
    const stop = subscribe<UploadProgress>(UPLOAD_PROGRESS_EVENT, (progress) => {
      setUploadState((prev) =>
        prev === null
          ? prev
          : {
              ...prev,
              processed: progress.processed,
              total: progress.total,
              // 成否は Rust 側が 1 枚ごとに確定させて送ってくる。
              // 完了を待たずにここで反映しないと、送信中ずっと「成功 0」に見えてしまう。
              succeeded: progress.succeeded,
              failed: progress.failed,
              currentName: fileNameOf(progress.currentPath),
            },
      );
    });

    try {
      const summary = await call<UploadSummary>("upload_photos", { paths });
      // 送信できたものだけを一覧に反映する。ここで再走査すると
      // ライブラリ全体のハッシュ計算が走り、送信のたびに数分固まってしまう。
      applyUploadResults(summary.results);
      setUploadState({
        processed: summary.results.length,
        total: paths.length,
        succeeded: summary.succeeded,
        failed: summary.failed,
        currentName: "",
        done: true,
      });
      // 成功したものだけ選択から外す。失敗した写真は選び直さずに再送できるよう残す。
      deselect(summary.results.filter((r) => r.uploaded).map((r) => r.path));
    } catch (error) {
      // コマンド自体が落ちた場合（鍵未設定など）。件数は分からないので理由だけ残す。
      setUploadState({
        processed: 0,
        total: paths.length,
        succeeded: 0,
        failed: paths.length,
        currentName: String(error),
        done: true,
      });
    } finally {
      stop();
    }
  }, [selectedPaths, deselect, setUploadState, applyUploadResults]);

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
    // 失敗したらフラグを戻す。戻さないと、起動時に一度こけただけで
    // プロセスが生きている限り二度と自動走査されなくなる。
    void scan().catch(() => {
      hasScannedOnce = false;
    });
  }, [scan]);
}

/** 絶対パスから表示用のファイル名だけを取り出す（Windows / POSIX の両方の区切りに対応）。 */
function fileNameOf(path: string): string {
  const index = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return index >= 0 ? path.slice(index + 1) : path;
}

/**
 * ハッシュを計算し、サーバーに送信済みかを問い合わせて一覧に反映する。
 *
 * 全写真を 1 回で処理せず、月（`YYYY-MM`）単位で新しい順に回す。理由は 3 つある。
 * 1. 1 か月ぶんが終わるたびに画面へ反映されるので、枚数が多くても途中経過が見える
 * 2. ある月で失敗しても他の月は判定できる（以前は 1 回の失敗で全月が未判定のままだった）
 * 3. 1 リクエストのハッシュ数が減り、サーバー側の負荷とタイムアウトの risk が下がる
 *
 * 失敗した月は握り潰さず、呼び出し側へ返して画面に出す。
 */
async function refreshUploadState(
  photos: Photo[],
  setPhotos: (update: (prev: Photo[]) => Photo[]) => void,
  onProgress: (state: UploadCheckState) => void,
): Promise<void> {
  if (photos.length === 0) return;

  // 月ごとに束ねる。month は走査時に Rust 側が入れている（`YYYY-MM`）。
  const byMonth = new Map<string, Photo[]>();
  for (const photo of photos) {
    const bucket = byMonth.get(photo.month);
    if (bucket) bucket.push(photo);
    else byMonth.set(photo.month, [photo]);
  }
  // 新しい月から片付ける。直近の写真ほど「送ったか」を知りたいことが多いため。
  const months = [...byMonth.keys()].sort().reverse();

  const failed: UploadCheckState["failed"] = [];
  for (let i = 0; i < months.length; i += 1) {
    const month = months[i];
    const target = byMonth.get(month) ?? [];
    onProgress({ doneMonths: i, totalMonths: months.length, currentMonth: month, failed });

    try {
      const hashes = await call<PhotoHash[]>("hash_photos", {
        paths: target.map((photo) => photo.path),
      });
      const byPath = new Map(hashes.map((entry) => [entry.path, entry.sha256]));

      // 送信済み判定はハッシュの一括問い合わせ。CHECK_HASH_LIMIT での分割は Rust 側が受け持つ。
      const uploaded = new Set(
        await call<string[]>("check_uploaded", { hashes: hashes.map((entry) => entry.sha256) }),
      );

      // 他の月の判定結果を消さないよう、必ず直前の一覧から差分で作り直す。
      const paths = new Set(target.map((photo) => photo.path));
      setPhotos((prev) =>
        prev.map((photo) => {
          if (!paths.has(photo.path)) return photo;
          const sha256 = byPath.get(photo.path) ?? null;
          return { ...photo, sha256, uploaded: sha256 !== null && uploaded.has(sha256) };
        }),
      );
    } catch (error) {
      // 1 か月の失敗で残りを止めない。原因は画面に出す。
      failed.push({ month, message: error instanceof Error ? error.message : String(error) });
    }
  }

  onProgress({
    doneMonths: months.length,
    totalMonths: months.length,
    currentMonth: "",
    failed,
  });
}
