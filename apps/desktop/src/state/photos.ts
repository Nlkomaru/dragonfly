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

/** 表示中のものを全選択する。 */
export const selectAllVisibleAtom = atom(null, (get, set) => {
  const next = new Set(get(selectedPathsAtom));
  for (const photo of get(visiblePhotosAtom)) next.add(photo.path);
  set(selectedPathsAtom, next);
});

/** 選択を全て解除する。 */
export const clearSelectionAtom = atom(null, (_get, set) => {
  set(selectedPathsAtom, new Set<string>());
});
