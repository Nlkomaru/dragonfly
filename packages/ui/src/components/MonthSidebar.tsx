import type { ReactNode } from "react";
import type { MonthBucket } from "@dragonfly/core";
import { Check } from "lucide-react";

import { cn } from "../lib/utils";
import { ScrollArea } from "./ui/scroll-area";
import { Separator } from "./ui/separator";

export interface MonthSidebarProps {
  /** 表示する月バケット。並び順は呼び出し側の責務（buildMonthBuckets は新しい順）。 */
  buckets: MonthBucket[];
  /** 現在選択中の月。未選択なら null。 */
  activeMonth: string | null;
  onSelectMonth: (month: string) => void;
  /** 最下部に置く任意の要素。デスクトップアプリでは設定へのリンクを入れる。 */
  footer?: ReactNode;
  className?: string;
}

/**
 * 月バケットの一覧を出す左サイドバー。
 * VRChat はスクリーンショットを `YYYY-MM` フォルダに分けて保存するため、
 * この単位がそのままナビゲーションの単位になる。
 */
export function MonthSidebar({
  buckets,
  activeMonth,
  onSelectMonth,
  footer,
  className,
}: MonthSidebarProps) {
  return (
    <nav
      aria-label="月の一覧"
      className={cn("flex h-full w-56 flex-col border-r border-border bg-background", className)}
    >
      <ScrollArea className="min-h-0 flex-1">
        <ul className="flex flex-col gap-0.5 p-2">
          {buckets.map((bucket) => {
            const isActive = bucket.month === activeMonth;
            // 全件アップロード済みかどうかで表示の強さを変える。
            const isFullyUploaded = bucket.count > 0 && bucket.uploadedCount === bucket.count;
            return (
              <li key={bucket.month}>
                <button
                  type="button"
                  aria-current={isActive ? "true" : undefined}
                  onClick={() => onSelectMonth(bucket.month)}
                  className={cn(
                    "flex w-full flex-col gap-0.5 rounded-md px-3 py-2 text-left transition-colors outline-none",
                    "focus-visible:ring-ring/50 focus-visible:ring-[3px]",
                    isActive
                      ? "bg-accent text-accent-foreground"
                      : "text-foreground hover:bg-accent/50",
                  )}
                >
                  <span className="flex items-center justify-between gap-2">
                    <span className="text-sm font-medium tabular-nums">{bucket.month}</span>
                    <span className="text-xs tabular-nums text-muted-foreground">
                      {bucket.count}
                    </span>
                  </span>
                  {/* アップロード済み件数は補助情報なので控えめに出す。 */}
                  {bucket.uploadedCount > 0 ? (
                    <span
                      className={cn(
                        "flex items-center gap-1 text-[11px] leading-none",
                        isFullyUploaded ? "text-primary" : "text-muted-foreground",
                      )}
                    >
                      <Check className="size-3" aria-hidden />
                      {bucket.uploadedCount} 件送信済み
                    </span>
                  ) : null}
                </button>
              </li>
            );
          })}
        </ul>
      </ScrollArea>

      {footer ? (
        <>
          <Separator />
          <div className="p-2">{footer}</div>
        </>
      ) : null}
    </nav>
  );
}
