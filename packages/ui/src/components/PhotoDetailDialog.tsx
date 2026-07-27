import type { ReactNode } from "react";
import type { Photo } from "@dragonfly/core";
import { Clock, Globe, Tag, Users } from "lucide-react";

import { cn } from "../lib/utils";
import { Badge } from "./ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "./ui/dialog";
import { Separator } from "./ui/separator";

export interface PhotoDetailDialogProps {
  /** 表示対象。null なら閉じている扱い。 */
  photo: Photo | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 原寸画像の URL。未取得なら undefined。 */
  imageSrc?: string;
  /** Web ギャラリーで付けたタグ。ローカル側では空配列でよい。 */
  tags?: string[];
  className?: string;
}

/** 撮影日時を「2026/06/12 21:34」形式に整える。 */
function formatTakenAt(takenAt: number): string {
  const date = new Date(takenAt);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 見出し付きの情報行。 */
function DetailRow({
  icon,
  label,
  children,
}: {
  icon: ReactNode;
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="flex gap-3">
      <span className="mt-0.5 text-muted-foreground [&_svg]:size-4">{icon}</span>
      <div className="min-w-0 flex-1">
        <p className="text-xs text-muted-foreground">{label}</p>
        <div className="text-sm">{children}</div>
      </div>
    </div>
  );
}

/**
 * 写真の詳細ダイアログ。主に Web ギャラリーから使い、
 * 画像・撮影日時・ワールド・同席者・タグをまとめて見せる。
 */
export function PhotoDetailDialog({
  photo,
  open,
  onOpenChange,
  imageSrc,
  tags = [],
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
      <DialogContent className={cn("max-w-3xl gap-0 p-0 sm:max-w-3xl", className)}>
        {photo ? (
          <>
            <div className="flex items-center justify-center bg-black">
              {imageSrc ? (
                <img
                  src={imageSrc}
                  alt={worldName}
                  className="max-h-[60vh] w-full object-contain"
                />
              ) : (
                <div className="flex h-64 w-full animate-pulse items-center justify-center bg-muted" />
              )}
            </div>

            <div className="flex flex-col gap-4 p-6">
              <div className="pr-8">
                <DialogTitle className="truncate">{worldName}</DialogTitle>
                <DialogDescription className="truncate">{photo.fileName}</DialogDescription>
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

              {tags.length > 0 ? (
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
