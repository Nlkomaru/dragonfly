import type { MouseEvent, ReactNode } from "react";
import type { Photo } from "@dragonfly/core";
import { Check, ImageOff, Info, Maximize2 } from "lucide-react";

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
  /** 情報ボタン（右上の ⓘ）。撮影日時やワールドなどの詳細を開く。 */
  onInfo?: (photo: Photo) => void;
  /**
   * 拡大表示の要求。閲覧モードではカード本体のクリック、
   * 選択モードでは右上の拡大ボタンから呼ばれる。
   */
  onPreview?: (photo: Photo) => void;
  /**
   * 選択 UI を出すか。既定は true（デスクトップ互換）。
   * false にするとチェックボックスと送信済みバッジを隠し、クリックで拡大表示する。
   */
  selectable?: boolean;
  className?: string;
}

/** 画像に重ねる小さな丸ボタン。ホバー・フォーカス時だけ現れる。 */
function OverlayButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={(event) => {
        // カード本体の選択・拡大と二重に反応させない。
        event.stopPropagation();
        onClick();
      }}
      className={cn(
        "flex size-6 items-center justify-center rounded-full bg-black/55 text-white shadow-sm backdrop-blur-sm",
        "opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100",
        "hover:bg-black/75 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80",
        "[&_svg]:size-3.5",
      )}
    >
      {children}
    </button>
  );
}

/**
 * 写真1枚分のカード。正方形にクロップして並べる。
 * 選択チェックボックスとアップロード済みバッジを重ね、
 * ホバー時に下部へワールド名を出す。
 *
 * カード本体のクリックは、選択モードでは選択、閲覧モードでは拡大表示に割り当てる。
 * 詳細（ⓘ）と拡大は右上の小さなボタンに寄せ、選択の邪魔をしないようにする。
 */
export function PhotoCard({
  photo,
  thumbnailSrc,
  selected = false,
  onToggle,
  onInfo,
  onPreview,
  selectable = true,
  className,
}: PhotoCardProps) {
  // ワールド名が空でも aria-label / オーバーレイが破綻しないようにする。
  const worldName = photo.metadata.world.name || "不明なワールド";

  // 選択モードならトグル、閲覧モードなら拡大表示を開く。
  const handleActivate = (shiftKey: boolean) => {
    if (selectable) {
      onToggle?.(photo, shiftKey);
      return;
    }
    onPreview?.(photo);
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
        // キーボード操作でも選択 / 拡大を開けるようにする。
        if (event.key === " " || event.key === "Enter") {
          event.preventDefault();
          handleActivate(event.shiftKey);
        }
      }}
      className={cn(
        "group relative aspect-square overflow-hidden rounded-lg border bg-muted transition-all outline-none",
        selectable ? "cursor-pointer" : "cursor-zoom-in",
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

      {/* 右上は 1 本の並びにまとめる。個別に位置をずらすと、
          送信済みバッジの有無でボタンが動いてしまうため。 */}
      <div className="absolute top-2 right-2 flex items-center gap-1">
        {/* 選択モードでは本体クリックが選択なので、拡大は専用のボタンに逃がす。 */}
        {selectable && onPreview ? (
          <OverlayButton label="拡大表示" onClick={() => onPreview(photo)}>
            <Maximize2 aria-hidden />
          </OverlayButton>
        ) : null}

        {onInfo ? (
          <OverlayButton label="詳細" onClick={() => onInfo(photo)}>
            <Info aria-hidden />
          </OverlayButton>
        ) : null}

        {/* 送信済みバッジ。選択 UI があるときだけ出す（Web 閲覧では不要なノイズになる）。 */}
        {selectable && photo.uploaded ? (
          <span
            title="送信済み"
            className="flex size-5 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-sm"
          >
            <Check className="size-3" aria-hidden />
            <span className="sr-only">送信済み</span>
          </span>
        ) : null}
      </div>

      {/* ワールド名はホバー時のみ。常時出すとグリッドが騒がしくなる。 */}
      <div
        className={cn(
          "pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent p-2 pt-6",
          "opacity-0 transition-opacity group-hover:opacity-100 group-focus:opacity-100",
        )}
      >
        <p className="truncate text-xs font-medium text-white">{worldName}</p>
      </div>
    </div>
  );
}
