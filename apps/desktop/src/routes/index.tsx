import { createFileRoute, Link } from "@tanstack/react-router";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { Settings, Images, RefreshCw } from "lucide-react";
import {
  Button,
  EmptyState,
  MonthSidebar,
  PhotoGrid,
  SelectionActionBar,
} from "@dragonfly/ui";
import {
  activeMonthAtom,
  clearSelectionAtom,
  monthBucketsAtom,
  scanningAtom,
  selectRangeAtom,
  selectedMonthAtom,
  selectedPathsAtom,
  selectedPhotosAtom,
  skippedCountAtom,
  togglePhotoAtom,
  visiblePhotosAtom,
} from "../state/photos";
import { usePhotoLibrary } from "../hooks/usePhotoLibrary";
import { useThumbnails } from "../hooks/useThumbnails";

export const Route = createFileRoute("/")({
  component: Index,
});

function Index() {
  const { scan, upload } = usePhotoLibrary();
  const buckets = useAtomValue(monthBucketsAtom);
  const activeMonth = useAtomValue(activeMonthAtom);
  const setSelectedMonth = useSetAtom(selectedMonthAtom);
  const visiblePhotos = useAtomValue(visiblePhotosAtom);
  const selectedPhotos = useAtomValue(selectedPhotosAtom);
  const [selectedPaths] = useAtom(selectedPathsAtom);
  const toggle = useSetAtom(togglePhotoAtom);
  const selectRange = useSetAtom(selectRangeAtom);
  const clearSelection = useSetAtom(clearSelectionAtom);
  const scanning = useAtomValue(scanningAtom);
  const skippedCount = useAtomValue(skippedCountAtom);

  const thumbnailSrcFor = useThumbnails(visiblePhotos.map((photo) => photo.path));

  return (
    <div className="flex h-screen">
      {/* 左サイドバー: VRChat が月フォルダで保存するので、月が一覧の単位になる。 */}
      <MonthSidebar
        buckets={buckets}
        activeMonth={activeMonth}
        onSelectMonth={setSelectedMonth}
        footer={
          <Link to="/settings" className="flex items-center gap-2 text-sm">
            <Settings className="size-4" />
            設定
          </Link>
        }
      />

      {/* PhotoGrid は自身の高さを測って行を間引くため、高さの決まった親が要る。 */}
      <main className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between border-b px-4 py-2">
          <div className="text-sm text-muted-foreground">
            {activeMonth ?? "—"} / {visiblePhotos.length} 枚
            {/* メタデータの無い写真は一覧に出さないので、件数だけ伝える。 */}
            {skippedCount > 0 && `（メタデータ無しで除外: ${skippedCount} 枚）`}
          </div>
          <Button variant="ghost" size="sm" onClick={() => void scan()} disabled={scanning}>
            <RefreshCw className={scanning ? "size-4 animate-spin" : "size-4"} />
            再走査
          </Button>
        </header>

        {visiblePhotos.length === 0 ? (
          <EmptyState
            icon={Images}
            title="表示できる写真がありません"
            description="VRCX のメタデータを持つスクリーンショットのみを表示します。設定で保存先を確認してください。"
          />
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
          />
        )}
      </main>

      {/* 選択は月をまたいで保持されるため、内訳を出して誤送信を防ぐ。 */}
      <SelectionActionBar
        selectedPhotos={selectedPhotos}
        onClear={clearSelection}
        actions={<Button onClick={() => void upload()}>アップロード</Button>}
      />
    </div>
  );
}
