import type { MouseEvent } from "react";
import type { Photo } from "@dragonfly/core";
import { Check, ImageOff } from "lucide-react";

import { cn } from "../lib/utils";
import { Checkbox } from "./ui/checkbox";

export interface PhotoCardProps {
  photo: Photo;
  /**
   * サムネイル画像の URL。デスクトップでは convertFileSrc、Web では R2 の URL。
   * 未生成のうちは undefined を渡すとスケルトンを出す。
   */
  thumbnailSrc?: string;
  /** 選択中かどうか。閲覧専用 (selectable=false) では無視される。 */
  selected?: boolean;
  /**
   * 選択状態のトグル要求。shift 押下を第2引数で伝え、範囲選択の判断は呼び出し側に委ねる。
   * selectable=false のときは呼ばれない。
   */
  onToggle?: (photo: Photo, shiftKey: boolean) => void;
  /** 詳細ダイアログを開くなど。selectable=false ではカード本体のクリックで呼ばれる。 */
  onOpen?: (photo: Photo) => void;
  /**
   * 選択 UI を出すか。既定は true（デスクトップ互換）。
   * false にするとチェックボックスと送信済みバッジを隠し、クリックで onOpen する。
   */
  selectable?: boolean;
  className?: string;
}

/**
 * 写真1枚分のカード。正方形にクロップして並べる。
 * 選択チェックボックスとアップロード済みバッジを重ね、
 * ホバー時に下部へワールド名を出す。
 */
export function PhotoCard({
  photo,
  thumbnailSrc,
  selected = false,
  onToggle,
  onOpen,
  selectable = true,
  className,
}: PhotoCardProps) {
  // ワールド名が空でも aria-label / オーバーレイが破綻しないようにする。
  const worldName = photo.metadata.world.name || "不明なワールド";

  // 選択モードならトグル、閲覧モードなら詳細を開く。
  const handleActivate = (shiftKey: boolean) => {
    if (selectable) {
      onToggle?.(photo, shiftKey);
      return;
    }
    onOpen?.(photo);
  };

  const handleClick = (event: MouseEvent<HTMLDivElement>) => {
    handleActivate(event.shiftKey);
  };

  return (
    <div
      role={selectable ? "checkbox" : "button"}
      aria-checked={selectable ? selected : undefined}
      aria-label={worldName}
      tabIndex={0}
      onClick={handleClick}
      onKeyDown={(event) => {
        // キーボード操作でも選択 / 詳細を開けるようにする。
        if (event.key === " " || event.key === "Enter") {
          event.preventDefault();
          handleActivate(event.shiftKey);
        }
      }}
      className={cn(
        "group relative aspect-square cursor-pointer overflow-hidden rounded-lg border bg-muted transition-all outline-none",
        "focus-visible:ring-ring/50 focus-visible:ring-[3px]",
        selectable && selected
          ? "border-primary ring-2 ring-primary"
          : "border-border hover:border-ring",
        className,
      )}
    >
      {thumbnailSrc ? (
        <img
          src={thumbnailSrc}
          alt={photo.fileName}
          loading="lazy"
          decoding="async"
          draggable={false}
          className="size-full object-cover"
        />
      ) : (
        // サムネイル生成待ち。読み込み中と分からない静止表示にはしない。
        <div className="flex size-full animate-pulse items-center justify-center bg-muted">
          <ImageOff className="size-6 text-muted-foreground/50" aria-hidden />
        </div>
      )}

      {/* 選択チェックボックス。閲覧モードでは出さない。常時表示せず、選択中かホバー時のみ出す。 */}
      {selectable ? (
        <div
          className={cn(
            "absolute top-2 left-2 transition-opacity",
            selected ? "opacity-100" : "opacity-0 group-hover:opacity-100 group-focus:opacity-100",
          )}
        >
          <Checkbox
            checked={selected}
            tabIndex={-1}
            aria-hidden
            className="size-5 border-white/70 bg-black/40 shadow-sm"
          />
        </div>
      ) : null}

      {/* 送信済みバッジ。選択 UI があるときだけ出す（Web 閲覧では不要なノイズになる）。 */}
      {selectable && photo.uploaded ? (
        <span
          title="送信済み"
          className="absolute top-2 right-2 flex size-5 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-sm"
        >
          <Check className="size-3" aria-hidden />
          <span className="sr-only">送信済み</span>
        </span>
      ) : null}

      {/* ワールド名はホバー時のみ。常時出すとグリッドが騒がしくなる。 */}
      <div
        className={cn(
          "pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent p-2 pt-6",
          "opacity-0 transition-opacity group-hover:opacity-100 group-focus:opacity-100",
        )}
      >
        <p className="truncate text-xs font-medium text-white">{worldName}</p>
      </div>

      {/* 詳細を開く操作は選択と衝突するため、選択モードでのみ別クリック領域に分ける。
          閲覧モードではカード全体が onOpen になるのでボタンは不要。 */}
      {selectable && onOpen ? (
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onOpen(photo);
          }}
          className="absolute right-2 bottom-2 rounded-md bg-black/50 px-2 py-1 text-[11px] text-white opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none"
        >
          詳細
        </button>
      ) : null}
    </div>
  );
}
