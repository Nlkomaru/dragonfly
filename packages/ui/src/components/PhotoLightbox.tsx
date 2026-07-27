import { useEffect, useState } from "react";
import type { Photo } from "@dragonfly/core";
import { ChevronLeft, ChevronRight, Loader2, X } from "lucide-react";

import { cn } from "../lib/utils";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "./ui/dialog";

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
  className?: string;
}

/**
 * 写真を前面いっぱいに出すだけのビューア。
 * 情報は ⓘ の詳細ダイアログ側に置き、ここでは画像を見ることだけに集中させる。
 * 画像を含め、どこを押しても閉じる。前後の移動と閉じるボタンだけは
 * クリックを伝播させず、押した通りに動くようにしている。
 */
export function PhotoLightbox({
  photo,
  open,
  onOpenChange,
  imageSrc,
  onPrev,
  onNext,
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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        // 既定の × は暗い背景に埋もれるので消し、白い自前のものを置く。
        showCloseButton={false}
        // 既定の中央寄せカードではなく、画面いっぱいの黒い面として使う。
        className={cn(
          "flex h-dvh w-screen max-w-none items-center justify-center rounded-none border-none bg-black/85 p-0 backdrop-blur-sm sm:max-w-none",
          className,
        )}
        onClick={() => onOpenChange(false)}
      >
        <DialogTitle className="sr-only">{worldName}</DialogTitle>
        <DialogDescription className="sr-only">{photo?.fileName ?? ""}</DialogDescription>

        {photo && imageSrc ? (
          <img
            src={imageSrc}
            alt={worldName}
            decoding="async"
            // 画像も含め、どこを押しても閉じる（DialogContent 側の onClick に任せる）。
            onLoad={() => setLoaded(true)}
            className={cn(
              "max-h-dvh max-w-full object-contain transition-opacity duration-200",
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

        <button
          type="button"
          aria-label="閉じる"
          onClick={(event) => {
            event.stopPropagation();
            onOpenChange(false);
          }}
          className="absolute top-4 right-4 rounded-full p-2 text-white/80 transition-opacity hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
        >
          <X className="size-5" aria-hidden />
        </button>

        {/* ファイル名だけは常に出す。どの写真を見ているか分からなくなるため。 */}
        <p className="pointer-events-none absolute bottom-4 left-1/2 max-w-[80vw] -translate-x-1/2 truncate rounded-full bg-black/50 px-3 py-1 text-xs text-white/80">
          {photo?.fileName ?? ""}
        </p>
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
