import type { ReactNode } from "react";
import type { Photo } from "@dragonfly/core";
import { X } from "lucide-react";

import { cn } from "../lib/utils";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Separator } from "./ui/separator";

export interface SelectionActionBarProps {
  /** 現在選択中の写真。空なら何も描画しない。 */
  selectedPhotos: Photo[];
  onClear: () => void;
  /** アップロードなどの操作ボタンを差し込むスロット。 */
  actions?: ReactNode;
  className?: string;
}

/**
 * 選択中に画面下部へ浮かぶ操作バー。
 * 月をまたいで選択できる仕様のため、2ヶ月以上に跨るときは内訳も出す。
 */
export function SelectionActionBar({
  selectedPhotos,
  onClear,
  actions,
  className,
}: SelectionActionBarProps) {
  // 選択が空のときはバー自体を出さない。
  if (selectedPhotos.length === 0) return null;

  // 月ごとの件数を数える。表示順は新しい月が上。
  const countsByMonth = new Map<string, number>();
  for (const photo of selectedPhotos) {
    countsByMonth.set(photo.month, (countsByMonth.get(photo.month) ?? 0) + 1);
  }
  const breakdown = [...countsByMonth.entries()].sort((a, b) => b[0].localeCompare(a[0]));

  return (
    <div
      role="status"
      className={cn(
        "pointer-events-auto flex items-center gap-3 rounded-xl border border-border bg-background/95 px-4 py-3 shadow-lg backdrop-blur",
        className,
      )}
    >
      <div className="flex flex-col gap-1">
        <span className="text-sm font-medium tabular-nums">{selectedPhotos.length} 枚を選択中</span>
        {/* 1ヶ月に収まっているなら内訳は冗長なので出さない。 */}
        {breakdown.length > 1 ? (
          <div className="flex flex-wrap items-center gap-1">
            {breakdown.map(([month, count]) => (
              <Badge key={month} variant="secondary" className="tabular-nums">
                {month} : {count}
              </Badge>
            ))}
          </div>
        ) : null}
      </div>

      <Separator orientation="vertical" className="h-8" />

      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" onClick={onClear}>
          <X aria-hidden />
          選択解除
        </Button>
        {actions}
      </div>
    </div>
  );
}
