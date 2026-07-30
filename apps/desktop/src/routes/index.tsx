import { useCallback, useEffect, useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import type { Photo } from "@dragonfly/core";
import { Images, RefreshCw, Upload } from "lucide-react";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  EmptyState,
  PhotoDetailDialog,
  PhotoGrid,
  PhotoLightbox,
  SelectionActionBar,
  UploadProgressBar,
} from "@dragonfly/ui";
import { assetUrl } from "@dragonfly/api-client";
import {
  activeMonthAtom,
  clearSelectionAtom,
  photosSourceAtom,
  scanProgressAtom,
  scanningAtom,
  selectRangeAtom,
  selectedPathsAtom,
  selectedPhotosAtom,
  skippedCountAtom,
  togglePhotoAtom,
  uploadCheckStateAtom,
  uploadStateAtom,
  uploadingAtom,
  visiblePhotosAtom,
} from "../state/photos";
import { usePhotoLibrary } from "../hooks/usePhotoLibrary";
import { useThumbnails } from "../hooks/useThumbnails";

export const Route = createFileRoute("/")({
  component: Index,
});

function Index() {
  const { photos, scan, upload, deleteRemote } = usePhotoLibrary();
  const activeMonth = useAtomValue(activeMonthAtom);
  const visiblePhotos = useAtomValue(visiblePhotosAtom);
  const selectedPhotos = useAtomValue(selectedPhotosAtom);
  const [selectedPaths] = useAtom(selectedPathsAtom);
  const toggle = useSetAtom(togglePhotoAtom);
  const selectRange = useSetAtom(selectRangeAtom);
  const clearSelection = useSetAtom(clearSelectionAtom);
  const scanning = useAtomValue(scanningAtom);
  const scanProgress = useAtomValue(scanProgressAtom);
  const photosSource = useAtomValue(photosSourceAtom);
  const skippedCount = useAtomValue(skippedCountAtom);
  const [uploadState, setUploadState] = useAtom(uploadStateAtom);
  const uploadCheck = useAtomValue(uploadCheckStateAtom);
  const uploading = useAtomValue(uploadingAtom);

  // 詳細（ⓘ）と拡大表示の対象。どちらも一時的な表示なので、アトムにせず画面に持つ。
  // 写真そのものではなくパスで持ち、表示のたびに一覧から引き直す。開いた時点の値を
  // 抱えると、削除で uploaded を false に戻しても古い値のままになってしまうため。
  const [detailPath, setDetailPath] = useState<string | null>(null);
  const [previewPath, setPreviewPath] = useState<string | null>(null);
  const detailPhoto = useMemo(
    () => photos.find((photo) => photo.path === detailPath) ?? null,
    [photos, detailPath],
  );
  const previewPhoto = useMemo(
    () => photos.find((photo) => photo.path === previewPath) ?? null,
    [photos, previewPath],
  );

  // 拡大表示に使う URL。元の PNG を asset プロトコル越しに読む。
  // 詳細ダイアログは 60vh に収まるのでサムネイルで足り、原寸はここでしか使わない
  // （4K PNG を毎回デコードさせると、ⓘ を押すたびに固まってしまう）。
  const [fullSizeSrc, setFullSizeSrc] = useState<string>();
  useEffect(() => {
    if (!previewPath) {
      setFullSizeSrc(undefined);
      return;
    }
    let cancelled = false;
    void assetUrl(previewPath).then((url) => {
      if (!cancelled) setFullSizeSrc(url);
    });
    return () => {
      cancelled = true;
    };
    // 写真オブジェクトではなくパスで見る。一覧が作り直されるたびに URL を取り直すと、
    // 拡大表示が読み込み中の表示に戻ってちらついてしまう。
  }, [previewPath]);

  /** 拡大表示のまま前後の写真へ移動する。表示中の並び順をそのまま辿る。 */
  const stepPreview = useCallback(
    (delta: number) => {
      setPreviewPath((current) => {
        if (current === null) return current;
        const index = visiblePhotos.findIndex((photo) => photo.path === current);
        // 端では止める。巡回させると、どこまで見たのか分からなくなる。
        return visiblePhotos[index + delta]?.path ?? current;
      });
    },
    [visiblePhotos],
  );

  // 削除の確認対象。押した瞬間に消さず、必ずこのダイアログを挟む。
  const [deletePath, setDeletePath] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const deleteTarget = useMemo(
    () => photos.find((photo) => photo.path === deletePath) ?? null,
    [photos, deletePath],
  );

  /** 削除の確認を開く。前回の失敗表示はここで畳む。 */
  const requestDelete = useCallback((photo: Photo) => {
    setDeleteError(null);
    setDeletePath(photo.path);
  }, []);

  /** 確認後の実行。成功すれば送信済みバッジが外れ、また送れる状態に戻る。 */
  const confirmDelete = useCallback(async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await deleteRemote(deleteTarget);
      setDeletePath(null);
    } catch (error) {
      // 失敗の理由はダイアログを閉じてから一覧の上に出す（他の状態表示と同じ場所）。
      setDeleteError(error instanceof Error ? error.message : String(error));
      setDeletePath(null);
    } finally {
      setDeleting(false);
    }
  }, [deleteTarget, deleteRemote]);

  // サムネイルの生成はグリッドが実際に描いている写真の分だけ要求する。
  const { thumbnailSrcFor, requestThumbnails } = useThumbnails();
  const handleVisiblePhotosChange = useCallback(
    (photos: Photo[]) => requestThumbnails(photos.map((photo) => photo.path)),
    [requestThumbnails],
  );

  return (
    // サイドバーは root にあるので、この画面は右側の中身だけを描く。
    // 操作バーを重ねるため relative にし、min-h-0 の連鎖も root から途切れさせない。
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      {/* PhotoGrid は自身の高さを測って行を間引くため、高さの決まった親が要る。 */}
      <main className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between border-b px-4 py-2">
          <div className="text-sm text-muted-foreground">
            {activeMonth ?? "—"} / {visiblePhotos.length} 枚
            {/* メタデータの無い写真は一覧に出さないので、件数だけ伝える。 */}
            {skippedCount > 0 && `（メタデータ無しで除外: ${skippedCount} 枚）`}
            {/* 起動直後は前回の結果を出しているだけなので、確定した一覧と見分けられるようにする。 */}
            {photosSource === "cache" && "（前回の一覧）"}
          </div>
          <Button variant="ghost" size="sm" onClick={() => void scan()} disabled={scanning}>
            <RefreshCw className={scanning ? "size-4 animate-spin" : "size-4"} />
            再走査
          </Button>
        </header>

        {/* 走査の進捗。キャッシュを先に出す都合で「一覧はあるのに裏で走っている」時間が
            できるため、止まっているのか進んでいるのかが分かるようにする。 */}
        {scanning && (
          <p className="shrink-0 border-b bg-muted/50 px-4 py-2 text-xs text-muted-foreground tabular-nums">
            {photosSource === "cache" && "前回の一覧を表示中 / "}
            {scanProgress
              ? `走査中… ${scanProgress.processed}/${scanProgress.total} 枚`
              : "走査を準備中…"}
          </p>
        )}

        {/* リモート削除の失敗。理由が分からないと再試行の判断ができないので必ず出す。 */}
        {deleteError && (
          <p className="shrink-0 border-b bg-destructive/10 px-4 py-2 text-xs text-destructive">
            サーバー上の写真を削除できませんでした: {deleteError}
          </p>
        )}

        {/* 送信済み判定の状況。以前はここが無く、失敗しても「送信済み 0 件」に見えていた。 */}
        {uploadCheck && uploadCheck.currentMonth !== "" && (
          <p className="shrink-0 border-b bg-muted/50 px-4 py-2 text-xs text-muted-foreground tabular-nums">
            送信済みを確認中… {uploadCheck.currentMonth}（{uploadCheck.doneMonths}/
            {uploadCheck.totalMonths} か月）
          </p>
        )}
        {uploadCheck && uploadCheck.currentMonth === "" && uploadCheck.failed.length > 0 && (
          <p className="shrink-0 border-b bg-destructive/10 px-4 py-2 text-xs text-destructive">
            送信済みの確認に失敗しました
            {uploadCheck.failed[0].month ? `（${uploadCheck.failed[0].month} ほか ` : "（"}
            {uploadCheck.failed.length} 件）: {uploadCheck.failed[0].message}
          </p>
        )}

        {/* 何枚中の何枚が送れたのかは送信中いちばん知りたい情報なので、常に上に出す。 */}
        {uploadState && (
          <UploadProgressBar
            processed={uploadState.processed}
            total={uploadState.total}
            succeeded={uploadState.succeeded}
            failed={uploadState.failed}
            currentName={uploadState.currentName}
            done={uploadState.done}
            onDismiss={() => setUploadState(null)}
          />
        )}

        {visiblePhotos.length === 0 ? (
          // 走査中はまだ増える可能性があるので「ありません」と言い切らない
          // （キャッシュが無い初回起動では、走査の間ずっとこれが出てしまう）。
          scanning ? null : (
            <EmptyState
              icon={Images}
              title="表示できる写真がありません"
              description="VRCX のメタデータを持つスクリーンショットのみを表示します。設定で保存先を確認してください。"
            />
          )
        ) : (
          <PhotoGrid
            className="min-h-0 flex-1"
            photos={visiblePhotos}
            selectedIds={selectedPaths}
            onToggle={(photo) => toggle(photo.path)}
            // グリッドは `photos` 上の index で範囲を伝えてくるので、パスに直して渡す。
            onRangeSelect={(from, to) =>
              selectRange(visiblePhotos.slice(from, to + 1).map((photo) => photo.path))
            }
            thumbnailSrcFor={(photo) => thumbnailSrcFor(photo.path)}
            onVisiblePhotosChange={handleVisiblePhotosChange}
            onInfo={(photo) => setDetailPath(photo.path)}
            onPreview={(photo) => setPreviewPath(photo.path)}
            // 消せるのはサーバー上の写真だけなので、送信済みのカードにだけ出す。
            onDelete={requestDelete}
            canDelete={(photo) => photo.uploaded}
          />
        )}
      </main>

      {/* 詳細。情報だけを出す（画像は拡大表示の役目）。
          タグはサーバー側のものなので、ローカルでは編集させない。
          削除はサーバー上の写真を消す操作なので、送信済みのときだけ出す。 */}
      <PhotoDetailDialog
        photo={detailPhoto}
        open={detailPhoto !== null}
        onOpenChange={(open) => {
          if (!open) setDetailPath(null);
        }}
        onPreview={detailPhoto ? () => setPreviewPath(detailPhoto.path) : undefined}
        onDelete={detailPhoto?.uploaded ? () => requestDelete(detailPhoto) : undefined}
      />

      {/* 拡大表示。詳細の上に重ねるので、閉じると詳細に戻る。
          showInfo で Web ギャラリーと同じ「画像＋情報パネル」の見た目に揃える。
          タグはローカルでは編集させないので onTagsChange は渡さない
          （ローカルの Photo はタグを持たないため、表示も「なし」になる）。 */}
      <PhotoLightbox
        photo={previewPhoto}
        open={previewPhoto !== null}
        onOpenChange={(open) => {
          if (!open) setPreviewPath(null);
        }}
        imageSrc={fullSizeSrc}
        onPrev={() => stepPreview(-1)}
        onNext={() => stepPreview(1)}
        onDelete={previewPhoto?.uploaded ? () => requestDelete(previewPhoto) : undefined}
        showInfo
      />

      {/* 削除の確認。取り消せない操作なので、何が消えて何が残るのかを本文で明言する。 */}
      <Dialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          // 実行中に閉じられると結果を出す先が無くなるので、その間は閉じさせない。
          if (!open && !deleting) setDeletePath(null);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>サーバー上の写真を削除しますか？</DialogTitle>
            <DialogDescription>
              サーバー上の写真だけを削除します。パソコンの中の写真はそのまま残ります。
              削除後はまたアップロードできます。
            </DialogDescription>
          </DialogHeader>
          {/* どの写真の話なのかを取り違えないよう、ファイル名を出す。 */}
          <p className="truncate text-sm text-muted-foreground">{deleteTarget?.fileName}</p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeletePath(null)} disabled={deleting}>
              キャンセル
            </Button>
            <Button variant="destructive" onClick={() => void confirmDelete()} disabled={deleting}>
              {deleting ? "削除中…" : "サーバーから削除"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 選択は月をまたいで保持されるため、内訳を出して誤送信を防ぐ。 */}
      {/* 設定画面では出したくないので、この画面の中に置いて下部に浮かせる。 */}
      <SelectionActionBar
        className="absolute bottom-4 left-1/2 -translate-x-1/2"
        selectedPhotos={selectedPhotos}
        onClear={clearSelection}
        actions={
          <Button onClick={() => void upload()} disabled={uploading}>
            <Upload aria-hidden />
            {/* 押す前に何枚送るのかが分かるよう、件数をラベルに入れる。 */}
            {uploading ? "送信中…" : `${selectedPhotos.length} 枚をアップロード`}
          </Button>
        }
      />
    </div>
  );
}
