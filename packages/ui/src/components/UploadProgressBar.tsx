import { CheckCircle2, Loader2, TriangleAlert, X } from "lucide-react";

import { cn } from "../lib/utils";
import { Button } from "./ui/button";

export interface UploadProgressBarProps {
  /** 送信が終わった件数（成功・失敗を問わない）。 */
  processed: number;
  total: number;
  succeeded: number;
  failed: number;
  /** 直近で処理した写真のファイル名。空なら出さない。 */
  currentName?: string;
  /** 全件終わったか。終了後は結果の要約に切り替わる。 */
  done: boolean;
  /** 結果表示を閉じる。送信中は閉じられないよう、呼び出し側で出し分ける。 */
  onDismiss?: () => void;
  className?: string;
}

/**
 * 送信の進行状況バー。
 * 「何件中の何件が終わったか」が分からないと待ち時間の見当が付かないため、
 * 件数・割合・処理中のファイル名を常に出す。
 */
export function UploadProgressBar({
  processed,
  total,
  succeeded,
  failed,
  currentName,
  done,
  onDismiss,
  className,
}: UploadProgressBarProps) {
  // total が 0 でもゼロ除算しないようにする。
  const ratio = total > 0 ? Math.min(1, processed / total) : 0;

  return (
    <div
      role="status"
      aria-live="polite"
      className={cn("flex flex-col gap-1.5 border-b bg-muted/40 px-4 py-2", className)}
    >
      <div className="flex items-center gap-2 text-sm">
        {done ? (
          failed > 0 ? (
            <TriangleAlert className="size-4 text-destructive" aria-hidden />
          ) : (
            <CheckCircle2 className="size-4 text-muted-foreground" aria-hidden />
          )
        ) : (
          <Loader2 className="size-4 animate-spin" aria-hidden />
        )}

        <span className="font-medium tabular-nums">
          {done ? "送信完了" : "送信中"} {processed} / {total} 枚
        </span>

        {/* 内訳は終わってから見たい情報なので、失敗が出るまでは成功数だけ添える。 */}
        <span className="text-muted-foreground tabular-nums">
          成功 {succeeded}
          {failed > 0 && ` / 失敗 ${failed}`}
        </span>

        {currentName && (
          <span className="min-w-0 flex-1 truncate text-muted-foreground">{currentName}</span>
        )}

        {done && onDismiss && (
          <Button variant="ghost" size="sm" className="ml-auto" onClick={onDismiss}>
            <X aria-hidden />
            閉じる
          </Button>
        )}
      </div>

      {/* 進捗バー。幅だけを動かすので、件数が増えても再レイアウトが起きない。 */}
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-border">
        <div
          className={cn(
            "h-full rounded-full transition-[width] duration-300 ease-out",
            failed > 0 ? "bg-destructive" : "bg-primary",
          )}
          style={{ width: `${ratio * 100}%` }}
        />
      </div>
    </div>
  );
}
