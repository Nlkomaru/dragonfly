import { useEffect, useState } from "react";
import type { Photo } from "@dragonfly/core";
import {
  ChevronLeft,
  ChevronRight,
  Clock,
  Globe,
  Loader2,
  Tag,
  Trash2,
  Users,
  X,
} from "lucide-react";

import { formatTakenAt } from "../lib/format";
import { cn } from "../lib/utils";
import { Badge } from "./ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "./ui/dialog";
import { Separator } from "./ui/separator";
import { DetailRow } from "./DetailRow";
import { TagEditor } from "./TagEditor";

export interface PhotoLightboxProps {
  /** 表示対象。null なら閉じている扱い。 */
  photo: Photo | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 原寸画像の URL。未取得なら undefined（読み込み中の表示になる）。 */
  imageSrc?: string;
  /** 前後の写真へ移動する。渡さなければ矢印を出さない。 */
  onPrev?: () => void;
  onNext?: () => void;
  /**
   * 削除の要求。渡したときだけ、閉じるボタンの隣にゴミ箱を出す。
   * 確認ダイアログは呼び出し側の責務で、ここでは押されたことを伝えるだけ。
   */
  onDelete?: () => void;
  /**
   * 情報パネルを出すかどうか。true にすると画像を左上に寄せ、
   * 右と下に撮影情報・タグを並べる（Web ギャラリー向け）。
   */
  showInfo?: boolean;
  /** 情報パネルに出すタグ。showInfo のときだけ使われる。 */
  tags?: string[];
  /** タグの変更を受け取る。渡したときだけ編集 UI になる。保存は呼び出し側に委ねる。 */
  onTagsChange?: (next: string[]) => void;
  /** タグ入力の補完候補。 */
  tagSuggestions?: string[];
  /** タグを保存中かどうか。 */
  tagsPending?: boolean;
  className?: string;
}

/**
 * 写真を大きく表示するビューア。
 * 既定では画面いっぱいに画像だけを出し、どこを押しても閉じる。
 * `showInfo` を渡すと画像は左上（横幅の約 7 割）に収まり、右に撮影情報とタグ、
 * 下に同席者を並べる。タグは `onTagsChange` を渡したときだけその場で編集できる。
 */
export function PhotoLightbox({
  photo,
  open,
  onOpenChange,
  imageSrc,
  onPrev,
  onNext,
  onDelete,
  showInfo = false,
  tags = [],
  onTagsChange,
  tagSuggestions = [],
  tagsPending = false,
  className,
}: PhotoLightboxProps) {
  // 写真を切り替えたら読み込み表示に戻す。前の写真が残って見えるのを防ぐ。
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    setLoaded(false);
  }, [imageSrc]);

  // 左右キーでも移動できるようにする。開いている間だけ購読する。
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "ArrowLeft") onPrev?.();
      if (event.key === "ArrowRight") onNext?.();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onPrev, onNext]);

  const worldName = photo?.metadata.world.name || "不明なワールド";
  const worldId = photo?.metadata.world.id ?? "";
  const instanceId = photo?.metadata.world.instanceId ?? "";
  const worldRefLabel =
    worldId || instanceId ? `${worldId}${worldId && instanceId ? ":" : ""}${instanceId}` : "記録なし";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        // 既定の × は暗い背景に埋もれるので消し、白い自前のものを画像側に置く。
        showCloseButton={false}
        // 既定の中央寄せカードではなく、画面いっぱいの面として使う。
        className={cn(
          "h-dvh w-screen max-w-none gap-0 rounded-none border-none p-0 shadow-none sm:max-w-none",
          showInfo
            ? // 画像（左上）・右パネル・下パネルの 3 セル。狭い画面では縦に積む。
              "grid grid-rows-[minmax(0,1fr)_auto_auto] bg-background md:grid-cols-[minmax(0,7fr)_minmax(0,3fr)] md:grid-rows-[minmax(0,1fr)_auto]"
            : "flex bg-transparent",
          className,
        )}
      >
        <DialogTitle className="sr-only">{worldName}</DialogTitle>
        <DialogDescription className="sr-only">{photo?.fileName ?? ""}</DialogDescription>

        {/* 画像エリア。情報パネルの有無に関わらず、ここはどこを押しても閉じる。 */}
        <div
          className="relative flex min-h-0 min-w-0 flex-1 items-center justify-center overflow-hidden bg-black/85 backdrop-blur-sm"
          onClick={() => onOpenChange(false)}
        >
          {photo && imageSrc ? (
            <img
              src={imageSrc}
              alt={worldName}
              decoding="async"
              onLoad={() => setLoaded(true)}
              className={cn(
                "max-h-full max-w-full object-contain transition-opacity duration-200",
                loaded ? "opacity-100" : "opacity-0",
              )}
            />
          ) : null}

          {/* 読み込みが終わるまでの間、真っ黒な画面にしない。 */}
          {!loaded ? (
            <Loader2 className="absolute size-8 animate-spin text-white/70" aria-hidden />
          ) : null}

          {onPrev ? (
            <NavButton label="前の写真" side="left" onClick={onPrev}>
              <ChevronLeft aria-hidden />
            </NavButton>
          ) : null}
          {onNext ? (
            <NavButton label="次の写真" side="right" onClick={onNext}>
              <ChevronRight aria-hidden />
            </NavButton>
          ) : null}

          {/* 右上のボタン列。削除と閉じるを 1 本にまとめ、
              削除の有無で閉じるボタンの位置が動かないようにする。 */}
          <div className="absolute top-4 right-4 flex items-center gap-1">
            {onDelete ? (
              <button
                type="button"
                aria-label="削除"
                title="削除"
                onClick={(event) => {
                  // 画像エリアのクリック（＝閉じる）に飲まれると、
                  // 呼び出し側の確認ダイアログを出す前に閉じてしまう。
                  event.stopPropagation();
                  onDelete();
                }}
                className="rounded-full p-2 text-white/80 transition-colors hover:bg-destructive hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
              >
                <Trash2 className="size-5" aria-hidden />
              </button>
            ) : null}

            <button
              type="button"
              aria-label="閉じる"
              onClick={(event) => {
                event.stopPropagation();
                onOpenChange(false);
              }}
              className="rounded-full p-2 text-white/80 transition-opacity hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
            >
              <X className="size-5" aria-hidden />
            </button>
          </div>

          {/* 情報パネルが無いときだけ、どの写真か分かるようファイル名を重ねる。 */}
          {!showInfo ? (
            <p className="pointer-events-none absolute bottom-4 left-1/2 max-w-[80vw] -translate-x-1/2 truncate rounded-full bg-black/50 px-3 py-1 text-xs text-white/80">
              {photo?.fileName ?? ""}
            </p>
          ) : null}
        </div>

        {showInfo && photo ? (
          <>
            {/* 右パネル。タグの操作が主目的なので、撮影情報と一緒に大きく取る。 */}
            <aside className="flex min-h-0 min-w-0 flex-col gap-4 overflow-y-auto border-t p-4 md:col-start-2 md:row-span-2 md:row-start-1 md:border-t-0 md:border-l">
              <div className="min-w-0">
                <h2 className="truncate text-lg leading-snug font-semibold">{worldName}</h2>
                <p className="truncate text-sm text-muted-foreground">{photo.fileName}</p>
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
              ) : (
                <DetailRow icon={<Tag />} label="タグ">
                  <div className="flex flex-wrap gap-1">
                    {tags.length > 0 ? (
                      tags.map((tag) => (
                        <Badge key={tag} variant="secondary">
                          {tag}
                        </Badge>
                      ))
                    ) : (
                      <span className="text-muted-foreground">なし</span>
                    )}
                  </div>
                </DetailRow>
              )}
            </aside>

            {/* 下パネル。同席者はバッジが横に並ぶので、幅の広いここに置く。 */}
            <div className="border-t px-4 py-3 md:col-start-1 md:row-start-2">
              <DetailRow icon={<Users />} label={`同席者 (${photo.metadata.players.length})`}>
                <div className="flex flex-wrap gap-1 pt-1">
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
            </div>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

/** 画像の左右に置く移動ボタン。 */
function NavButton({
  label,
  side,
  onClick,
  children,
}: {
  label: string;
  side: "left" | "right";
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={(event) => {
        // 前後の移動が「閉じる」に飲まれないようにする。
        event.stopPropagation();
        onClick();
      }}
      className={cn(
        "absolute top-1/2 -translate-y-1/2 rounded-full bg-black/40 p-2 text-white/80",
        "hover:bg-black/70 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white",
        "[&_svg]:size-6",
        side === "left" ? "left-4" : "right-4",
      )}
    >
      {children}
    </button>
  );
}
