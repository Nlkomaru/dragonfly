// 写真一覧・月バケット・選択状態のアトム。
// 選択は月をまたいで保持する（複数の月から選んで1回で送れるようにするため）。

import { atom } from "jotai";
import { buildMonthBuckets, type Photo } from "@dragonfly/core";

/** 走査で得た写真（VRCX メタデータを持つものだけ）。 */
export const photosAtom = atom<Photo[]>([]);

/** メタデータが無く一覧から除外した件数。ステータス表示にのみ使う。 */
export const skippedCountAtom = atom(0);

/** 走査中かどうか。走査中は再走査ボタンを止める。 */
export const scanningAtom = atom(false);

/** 一覧の出どころ。 */
export type PhotosSource =
  /** まだ何も読んでいない。 */
  | "none"
  /** 前回の走査結果（キャッシュ）を表示している。 */
  | "cache"
  /** 今回の走査で確定した一覧を表示している。 */
  | "scan";

/**
 * 一覧の出どころ。
 *
 * 起動直後はキャッシュを先に描くので、そのままだと「消したはずの写真がまだ居る」
 * ような状態を確定した一覧と見分けられない。ヘッダーに出すためだけに持つ。
 */
export const photosSourceAtom = atom<PhotosSource>("none");

/** 走査の進捗（Rust の `scan_progress` イベント）。null なら進捗待ち。 */
export const scanProgressAtom = atom<{ processed: number; total: number } | null>(null);

/** 送信済み判定の進行状況。null なら実行していない。 */
export interface UploadCheckState {
  /** 判定が終わった月の数。 */
  doneMonths: number;
  /** 判定する月の総数。 */
  totalMonths: number;
  /** いま判定している月（`YYYY-MM`）。終わっていれば空文字。 */
  currentMonth: string;
  /** 判定に失敗した月。原因が分かるようメッセージも持つ。 */
  failed: Array<{ month: string; message: string }>;
}

/**
 * 送信済み判定の進行状況。
 *
 * 以前はこの処理が失敗しても画面に何も出ず、「送信済みが 1 件も出ない」状態と
 * 「まだ判定していない」状態が見分けられなかった。失敗した月をここに残して表示する。
 */
export const uploadCheckStateAtom = atom<UploadCheckState | null>(null);

/** 送信の進行状況。null なら送信していない。 */
export interface UploadState {
  /** 送信が終わった件数（成功・失敗を問わない）。 */
  processed: number;
  total: number;
  /** 送信に成功した件数。 */
  succeeded: number;
  /** 送信に失敗した件数。 */
  failed: number;
  /** 直近で処理した写真のファイル名。どこまで進んだかを示す。 */
  currentName: string;
  /** 全件終わったか。終了後もサマリを出したままにするため、null に戻さず持つ。 */
  done: boolean;
}

/** 送信の進行状況。アクションバーとヘッダーの表示に使う。 */
export const uploadStateAtom = atom<UploadState | null>(null);

/** 送信中かどうか。送信中はボタンを止める。 */
export const uploadingAtom = atom((get) => {
  const state = get(uploadStateAtom);
  return state !== null && !state.done;
});

/** サイドバーで選択中の月（`YYYY-MM`）。未選択なら最新の月を使う。 */
export const selectedMonthAtom = atom<string | null>(null);

/** 選択中の写真のパス集合。Photo.path を一意キーとして扱う。 */
export const selectedPathsAtom = atom<ReadonlySet<string>>(new Set<string>());

/** 送信済みを隠すフィルタ。 */
export const hideUploadedAtom = atom(false);

/** ワールド名での絞り込み（部分一致、空なら絞らない）。 */
export const worldFilterAtom = atom("");

/** 同席プレイヤー名での絞り込み（部分一致、空なら絞らない）。 */
export const playerFilterAtom = atom("");

/** サイドバーに出す月バケット。写真が変われば自動で作り直される。 */
export const monthBucketsAtom = atom((get) => buildMonthBuckets(get(photosAtom)));

/** 実際に表示する月。未選択なら最新の月にフォールバックする。 */
export const activeMonthAtom = atom((get) => {
  const selected = get(selectedMonthAtom);
  if (selected) return selected;
  return get(monthBucketsAtom)[0]?.month ?? null;
});

/** 選択中の月とフィルタを適用した表示対象。 */
export const visiblePhotosAtom = atom((get) => {
  const month = get(activeMonthAtom);
  const hideUploaded = get(hideUploadedAtom);
  const world = get(worldFilterAtom).trim().toLowerCase();
  const player = get(playerFilterAtom).trim().toLowerCase();

  return get(photosAtom).filter((photo) => {
    if (month && photo.month !== month) return false;
    if (hideUploaded && photo.uploaded) return false;
    if (world && !photo.metadata.world.name.toLowerCase().includes(world)) return false;
    if (
      player &&
      !photo.metadata.players.some((p) => p.displayName.toLowerCase().includes(player))
    ) {
      return false;
    }
    return true;
  });
});

/** 選択中の写真そのもの。アクションバーの内訳表示に使う。 */
export const selectedPhotosAtom = atom((get) => {
  const selected = get(selectedPathsAtom);
  return get(photosAtom).filter((photo) => selected.has(photo.path));
});

/** 1枚の選択を反転する。 */
export const togglePhotoAtom = atom(null, (get, set, path: string) => {
  const next = new Set(get(selectedPathsAtom));
  if (next.has(path)) next.delete(path);
  else next.add(path);
  set(selectedPathsAtom, next);
});

/** shift クリックによる範囲選択。表示中の並び順に対して適用する。 */
export const selectRangeAtom = atom(null, (get, set, paths: string[]) => {
  const next = new Set(get(selectedPathsAtom));
  for (const path of paths) next.add(path);
  set(selectedPathsAtom, next);
});

/**
 * 送信結果を一覧に反映する。
 * 送信のたびに全件を再走査すると数分待たされるので、結果の写真だけを更新する。
 */
export const applyUploadResultsAtom = atom(
  null,
  (get, set, results: { path: string; sha256: string | null; uploaded: boolean }[]) => {
    const byPath = new Map(results.map((result) => [result.path, result]));
    if (byPath.size === 0) return;
    set(
      photosAtom,
      get(photosAtom).map((photo) => {
        const result = byPath.get(photo.path);
        if (!result?.uploaded) return photo;
        return { ...photo, sha256: result.sha256 ?? photo.sha256, uploaded: true };
      }),
    );
  },
);

/**
 * リモート（サーバー側）の写真を消したことを一覧に反映する。
 *
 * 消したのはサーバーの行だけで、ローカルのファイルはそのまま残るので、
 * 写真自体は一覧に残したまま送信済みの印だけを外す（また送れる状態に戻す）。
 * sha256 はファイルが変わっていない限り有効なので消さない。
 */
export const markRemoteDeletedAtom = atom(null, (get, set, path: string) => {
  set(
    photosAtom,
    get(photosAtom).map((photo) => (photo.path === path ? { ...photo, uploaded: false } : photo)),
  );
});

/** 選択を全て解除する。 */
export const clearSelectionAtom = atom(null, (_get, set) => {
  set(selectedPathsAtom, new Set<string>());
});

/** 指定したパスだけを選択から外す。送信に成功したものを畳むのに使う。 */
export const deselectPathsAtom = atom(null, (get, set, paths: string[]) => {
  if (paths.length === 0) return;
  const next = new Set(get(selectedPathsAtom));
  for (const path of paths) next.delete(path);
  set(selectedPathsAtom, next);
});
