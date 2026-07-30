// 走査・ハッシュ計算・送信済み判定・アップロードという一連の流れを、
// Rust 側のコマンドとイベントに繋ぐフック。画面はこのフックだけを見ればよい。

import { useCallback, useEffect } from "react";
import { useAtom, useSetAtom } from "jotai";
import { call, subscribe } from "@dragonfly/api-client";
import type { Photo, ScanResult, UploadProgress, UploadSummary } from "@dragonfly/core";
import {
  applyUploadResultsAtom,
  deselectPathsAtom,
  markRemoteDeletedAtom,
  photosAtom,
  photosSourceAtom,
  scanProgressAtom,
  scanningAtom,
  selectedPathsAtom,
  skippedCountAtom,
  uploadCheckStateAtom,
  uploadStateAtom,
  type UploadCheckState,
} from "../state/photos";

/** Rust 側が送信 1 件ごとに発火するイベント名（`uploader.rs` と同じ値）。 */
const UPLOAD_PROGRESS_EVENT = "upload_progress";

/** Rust 側が走査中に発火するイベント名（`scanner.rs` の `SCAN_PROGRESS_EVENT` と同じ値）。 */
const SCAN_PROGRESS_EVENT = "scan_progress";

/** Rust の `hash_photos` が返す1件分。 */
interface PhotoHash {
  path: string;
  sha256: string;
}

/** `scan_progress` イベントの中身（`scanner.rs` の `ScanProgress`）。 */
interface ScanProgress {
  processed: number;
  total: number;
  currentPath: string;
}

/** キャッシュ更新コマンドに渡す送信状態 1 件分（`scan_cache.rs` の `UploadStateEntry`）。 */
interface UploadStateEntry {
  path: string;
  sha256: string | null;
  uploaded: boolean;
}

/**
 * 走査結果に、直前の一覧が持っていた sha256 / uploaded を引き継ぐ。
 *
 * 走査は毎回 `sha256: null` / `uploaded: false` の写真を返すため、そのまま入れ替えると
 * キャッシュから復元した送信済みバッジが走査完了の瞬間に一度全部消えてしまう。
 * 同じパスなら同じ写真として扱い、直後の送信済み判定で上書きされるまで前の値を見せる。
 * （パスはそのままに中身が差し替わった写真は一時的に古いハッシュを持つが、
 *   数秒後の判定で直るので、バッジが消えて見えるより害が小さい。）
 */
function carryUploadState(previous: Photo[], scanned: Photo[]): Photo[] {
  const byPath = new Map(previous.map((photo) => [photo.path, photo]));
  return scanned.map((photo) => {
    const before = byPath.get(photo.path);
    if (!before) return photo;
    return { ...photo, sha256: before.sha256, uploaded: before.uploaded };
  });
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
  const setPhotosSource = useSetAtom(photosSourceAtom);
  const setScanProgress = useSetAtom(scanProgressAtom);
  const markRemoteDeleted = useSetAtom(markRemoteDeletedAtom);

  /**
   * 前回の走査結果（Rust 側のキャッシュ）をそのまま一覧に出す。
   *
   * 走査は数千枚あると数秒かかり、その間ずっと一覧が空になってしまうので、
   * 起動直後の見た目だけを先に埋めるために使う。表示を速くするためだけの仕組みなので、
   * 失敗しても画面にエラーを出さず、そのまま本物の走査に進む。
   */
  const restoreFromCache = useCallback(async () => {
    try {
      const cached = await call<ScanResult>("cached_photos");
      // キャッシュが無い初回起動は空で返る。空で上書きしても得るものが無いので何もしない。
      if (cached.photos.length === 0) return;
      setPhotos(cached.photos);
      setSkipped(cached.skippedCount);
      setPhotosSource("cache");
    } catch (error) {
      console.warn("could not restore the scan cache", error);
    }
  }, [setPhotos, setSkipped, setPhotosSource]);

  /**
   * スクリーンショットを走査し直す。メタデータの無いものは Rust 側で除外済み。
   *
   * 例外は必ずここで受け止める。呼び出し側が `void scan()` で捨てているため、
   * ここで拾わないと失敗が画面にもコンソールにも残らず、
   * 「一覧は出るのに送信済みが 0 件のまま」という原因不明の状態になる。
   */
  const scan = useCallback(async () => {
    setScanning(true);
    setScanProgress(null);
    // 走査中だけ進捗を購読する。何枚中の何枚まで見たのかが分からないと、
    // キャッシュを出している間「止まっているのか進んでいるのか」が判断できない。
    const stop = subscribe<ScanProgress>(SCAN_PROGRESS_EVENT, (progress) => {
      setScanProgress({ processed: progress.processed, total: progress.total });
    });
    try {
      const result = await call<ScanResult>("scan_photos");
      // 走査結果は送信済みの情報を持たないので、直前の一覧から引き継いでから置き換える。
      setPhotos((prev) => carryUploadState(prev, result.photos));
      setSkipped(result.skippedCount);
      setPhotosSource("scan");
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
      stop();
      setScanProgress(null);
      setScanning(false);
    }
  }, [setPhotos, setScanning, setScanProgress, setSkipped, setPhotosSource, setUploadCheck]);

  /**
   * サーバー側にあるこの写真を削除する。ローカルのスクリーンショットは消さない。
   *
   * サーバー上の行はハッシュで引く（デスクトップは写真の ID を持たないため）。
   * 確認は呼び出し側で済ませてから呼ぶこと。失敗は throw するので画面側で理由を出す。
   */
  const deleteRemote = useCallback(
    async (photo: Photo) => {
      // ハッシュは送信済み判定と同時に入るので uploaded な写真には必ずあるが、
      // 無いまま Rust に渡すと「hex ではない」という分かりにくい理由で落ちる。
      if (!photo.sha256) {
        throw new Error("ハッシュが未計算のため削除できません。再走査してからお試しください。");
      }
      await call<void>("delete_remote_photo", { sha256: photo.sha256 });
      markRemoteDeleted(photo.path);
      // キャッシュ側も戻す。戻さないと次の起動で送信済みバッジが復活してしまう。
      // sha256 はそのまま残す（ローカルのファイルは変わっていないため、次回も使える）。
      await updateScanCache([{ path: photo.path, sha256: photo.sha256, uploaded: false }]);
    },
    [markRemoteDeleted],
  );

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
      // 送れたものはキャッシュにも反映する。次の起動でバッジが出ないと、
      // 送信済み判定が終わるまで「送ったはずなのに送れていない」ように見えてしまう。
      // 失敗した写真は含めない（ハッシュが取れておらず、既存の値を消してしまうため）。
      await updateScanCache(
        summary.results
          .filter((result) => result.uploaded)
          .map((result) => ({ path: result.path, sha256: result.sha256, uploaded: true })),
      );
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

  return { photos, scanning, scan, upload, deleteRemote, restoreFromCache };
}

/**
 * 起動時に一度だけ走査する。root と各画面の両方から呼ばれても二重に走らないよう、
 * モジュールスコープのフラグで守る（画面の再マウントでも再走査しない）。
 */
let hasScannedOnce = false;

export function useInitialPhotoScan(): void {
  const { scan, restoreFromCache } = usePhotoLibrary();

  useEffect(() => {
    if (hasScannedOnce) return;
    hasScannedOnce = true;
    // 失敗したらフラグを戻す。戻さないと、起動時に一度こけただけで
    // プロセスが生きている限り二度と自動走査されなくなる。
    void (async () => {
      // キャッシュを先に描いてから走査する。並べて走らせると、走査の方が先に
      // 終わったときに古いキャッシュで新しい一覧を上書きしてしまう。
      await restoreFromCache();
      await scan();
    })().catch(() => {
      hasScannedOnce = false;
    });
  }, [scan, restoreFromCache]);
}

/**
 * 送信状態を走査キャッシュへ書き戻す。次の起動でバッジが最初から正しく出るようにする。
 *
 * キャッシュに行が無いパスは Rust 側で無視されるため、必ず `scan_photos` の完了後に呼ぶ。
 * 表示には影響しないので、失敗しても警告に留めて処理を続ける。
 */
async function updateScanCache(entries: UploadStateEntry[]): Promise<void> {
  if (entries.length === 0) return;
  try {
    await call<void>("update_scan_cache_upload_state", { entries });
  } catch (error) {
    console.warn("could not update the scan cache", error);
  }
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

      // この月の確定値。画面とキャッシュの両方に同じものを流す。
      const entries: UploadStateEntry[] = target.map((photo) => {
        const sha256 = byPath.get(photo.path) ?? null;
        return { path: photo.path, sha256, uploaded: sha256 !== null && uploaded.has(sha256) };
      });
      const byEntryPath = new Map(entries.map((entry) => [entry.path, entry]));

      // 他の月の判定結果を消さないよう、必ず直前の一覧から差分で作り直す。
      setPhotos((prev) =>
        prev.map((photo) => {
          const entry = byEntryPath.get(photo.path);
          if (!entry) return photo;
          return { ...photo, sha256: entry.sha256, uploaded: entry.uploaded };
        }),
      );
      // 次の起動でキャッシュから復元したときも、この判定結果をそのまま出せるようにする。
      await updateScanCache(entries);
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
