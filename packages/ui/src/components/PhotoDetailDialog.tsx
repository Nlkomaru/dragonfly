import type { Photo } from "@dragonfly/core";
import { Clock, Globe, Maximize2, Tag, Trash2, Users } from "lucide-react";

import { formatTakenAt } from "../lib/format";
import { cn } from "../lib/utils";
import { DetailRow } from "./DetailRow";
import { TagEditor } from "./TagEditor";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "./ui/dialog";
import { Separator } from "./ui/separator";

export interface PhotoDetailDialogProps {
  /** 表示対象。null なら閉じている扱い。 */
  photo: Photo | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Web ギャラリーで付けたタグ。ローカル側では空配列でよい。 */
  tags?: string[];
  /**
   * タグの変更を受け取る。渡したときだけ編集 UI になる。
   * 保存はこのコンポーネントでは行わず、呼び出し側に委ねる。
   */
  onTagsChange?: (next: string[]) => void;
  /** 入力補完に出すタグ候補。 */
  tagSuggestions?: string[];
  /** タグを保存中かどうか。 */
  tagsPending?: boolean;
  /** 画像を前面いっぱいに出す要求。渡さなければ拡大ボタンを出さない。 */
  onPreview?: () => void;
  /**
   * 削除の要求。渡したときだけ削除ボタンを出す。
   * 確認ダイアログは呼び出し側の責務で、ここでは押されたことを伝えるだけ。
   */
  onDelete?: () => void;
  className?: string;
}

/**
 * 写真の情報だけを見せるダイアログ。
 * 画像は拡大表示（PhotoLightbox）の役目なので、ここでは持たない。
 * 撮影日時・ワールド・同席者・タグを、上から順に一覧できる形に並べる。
 */
export function PhotoDetailDialog({
  photo,
  open,
  onOpenChange,
  tags = [],
  onTagsChange,
  tagSuggestions = [],
  tagsPending = false,
  onPreview,
  onDelete,
  className,
}: PhotoDetailDialogProps) {
  // ワールド名が空文字の写真でもタイトルが空にならないようにする。
  const worldName = photo?.metadata.world.name || "不明なワールド";
  const worldId = photo?.metadata.world.id ?? "";
  const instanceId = photo?.metadata.world.instanceId ?? "";
  const worldRefLabel =
    worldId || instanceId ? `${worldId}${worldId && instanceId ? ":" : ""}${instanceId}` : "記録なし";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={cn("max-w-lg gap-0 sm:max-w-lg", className)}>
        {photo ? (
          <>
            {/* DialogContent は grid なので、min-w-0 が無いと長いインスタンス ID が
                グリッド子要素の最小幅を押し広げ、中身がダイアログ外にはみ出す。 */}
            <div className="flex min-w-0 flex-col gap-4">
              <div className="flex items-start gap-2 pr-8">
                <div className="min-w-0 flex-1">
                  <DialogTitle className="truncate">{worldName}</DialogTitle>
                  <DialogDescription className="truncate">{photo.fileName}</DialogDescription>
                </div>
                {/* 情報から画像を見に行く導線。画像自体はここには置かない。 */}
                {onPreview ? (
                  <Button type="button" variant="outline" size="sm" onClick={onPreview}>
                    <Maximize2 aria-hidden />
                    拡大
                  </Button>
                ) : null}

                {/* 削除は誤爆すると取り返しが付かないので、
                    文字を出さないアイコンだけのボタンにして拡大と大きさを揃える。 */}
                {onDelete ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    aria-label="削除"
                    title="削除"
                    onClick={onDelete}
                    className="text-destructive hover:bg-destructive hover:text-white"
                  >
                    <Trash2 aria-hidden />
                  </Button>
                ) : null}
              </div>

              <Separator />

              <DetailRow icon={<Clock />} label="撮影日時">
                <span className="tabular-nums">{formatTakenAt(photo.takenAt)}</span>
                <span className="ml-2 text-muted-foreground tabular-nums">
                  {photo.width}×{photo.height}
                </span>
              </DetailRow>

              <DetailRow icon={<Globe />} label="ワールド">
                <p>{worldName}</p>
                {/* インスタンス ID は長いので折り返さず横スクロールさせる。 */}
                <p className="overflow-x-auto text-xs whitespace-nowrap text-muted-foreground">
                  {worldRefLabel}
                </p>
              </DetailRow>

              <DetailRow icon={<Users />} label={`同席者 (${photo.metadata.players.length})`}>
                <div className="flex flex-wrap gap-1">
                  {photo.metadata.players.length > 0 ? (
                    photo.metadata.players.map((player) => (
                      <Badge key={player.id} variant="outline">
                        {player.displayName}
                      </Badge>
                    ))
                  ) : (
                    <span className="text-muted-foreground">記録なし</span>
                  )}
                </div>
              </DetailRow>

              {/* 編集できるときは、まだ 1 つも無くても入力欄を出す（付ける導線が要るため）。 */}
              {onTagsChange ? (
                <DetailRow icon={<Tag />} label="タグ">
                  <TagEditor
                    value={tags}
                    onChange={onTagsChange}
                    suggestions={tagSuggestions}
                    pending={tagsPending}
                    className="pt-1"
                  />
                </DetailRow>
              ) : tags.length > 0 ? (
                <DetailRow icon={<Tag />} label="タグ">
                  <div className="flex flex-wrap gap-1">
                    {tags.map((tag) => (
                      <Badge key={tag} variant="secondary">
                        {tag}
                      </Badge>
                    ))}
                  </div>
                </DetailRow>
              ) : null}
            </div>
          </>
        ) : (
          // photo が null でも Radix の都合で children は要るため、空のタイトルだけ置く。
          <DialogTitle className="sr-only">写真の詳細</DialogTitle>
        )}
      </DialogContent>
    </Dialog>
  );
}
