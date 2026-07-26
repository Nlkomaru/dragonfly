import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Photo } from "@dragonfly/core";

import { cn } from "../lib/utils";
import { PhotoCard } from "./PhotoCard";

/** 1列あたりの最小幅(px)。これを下回らない範囲で列数を増やす。 */
const MIN_COLUMN_WIDTH = 176;
/** カード間の余白(px)。Tailwind の gap-3 と揃える。 */
const GAP = 12;
/** 画面外に余分に描画する行数。スクロール中の空白を防ぐ。 */
const OVERSCAN_ROWS = 3;
/** 実測前（SSR / 初回描画）に使う既定値。ここが 0 だと SSR 出力が空になる。 */
const FALLBACK_COLUMNS = 4;
const FALLBACK_VIEWPORT_HEIGHT = 900;

export interface PhotoGridProps {
  photos: Photo[];
  /** 選択中の写真パス。件数が多いので配列ではなく Set で受ける。 */
  selectedIds: ReadonlySet<string>;
  /** 単体の選択トグル要求。 */
  onToggle: (photo: Photo) => void;
  /** shift クリックによる範囲選択要求。index は `photos` 上の位置。 */
  onRangeSelect?: (fromIndex: number, toIndex: number) => void;
  /** 写真ごとのサムネイル URL を返す。未生成なら undefined。 */
  thumbnailSrcFor?: (photo: Photo) => string | undefined;
  onOpen?: (photo: Photo) => void;
  className?: string;
}

/**
 * 写真グリッド。1000 枚規模でも軽く保つため、依存を足さずに簡易な行仮想化を行う。
 * スクロールはこのコンポーネント自身が持つ要素で発生させる（ScrollArea の中に
 * 入れると Radix 内部の viewport でスクロールが起き、位置を追えなくなるため）。
 */
export function PhotoGrid({
  photos,
  selectedIds,
  onToggle,
  onRangeSelect,
  thumbnailSrcFor,
  onOpen,
  className,
}: PhotoGridProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const [scrollTop, setScrollTop] = useState(0);
  // 範囲選択の起点。選択状態そのものではなく操作の途中状態なのでローカルに持つ。
  const anchorIndexRef = useRef<number | null>(null);

  // 幅と高さの実測はクライアントでのみ行う（web 側は SSR されるため）。
  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;

    const measure = () => {
      setViewport({ width: element.clientWidth, height: element.clientHeight });
    };
    measure();

    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const handleScroll = useCallback(() => {
    const element = scrollRef.current;
    if (element) setScrollTop(element.scrollTop);
  }, []);

  const layout = useMemo(() => {
    // 実測前は既定値で描画し、初期表示が空にならないようにする。
    const width = viewport.width || MIN_COLUMN_WIDTH * FALLBACK_COLUMNS + GAP * FALLBACK_COLUMNS;
    const height = viewport.height || FALLBACK_VIEWPORT_HEIGHT;
    const columns = Math.max(1, Math.floor((width + GAP) / (MIN_COLUMN_WIDTH + GAP)));
    const columnWidth = (width - GAP * (columns - 1)) / columns;
    // カードは正方形なので、行の送り幅は列幅 + 余白。
    const rowStride = columnWidth + GAP;
    const rowCount = Math.ceil(photos.length / columns);

    const firstVisibleRow = Math.max(0, Math.floor(scrollTop / rowStride) - OVERSCAN_ROWS);
    const visibleRowCount = Math.ceil(height / rowStride) + OVERSCAN_ROWS * 2;
    const lastRow = Math.min(rowCount, firstVisibleRow + visibleRowCount);

    return {
      columns,
      rowStride,
      totalHeight: Math.max(0, rowCount * rowStride - GAP),
      startIndex: firstVisibleRow * columns,
      endIndex: Math.min(photos.length, lastRow * columns),
      offsetY: firstVisibleRow * rowStride,
    };
  }, [photos.length, scrollTop, viewport.height, viewport.width]);

  const visiblePhotos = photos.slice(layout.startIndex, layout.endIndex);

  // PhotoCard から上がってきた shift の有無を、単体トグルか範囲選択かに振り分ける。
  const handleToggle = (photo: Photo, index: number, shiftKey: boolean) => {
    const anchor = anchorIndexRef.current;
    if (shiftKey && anchor !== null && onRangeSelect) {
      onRangeSelect(Math.min(anchor, index), Math.max(anchor, index));
      return;
    }
    anchorIndexRef.current = index;
    onToggle(photo);
  };

  return (
    <div
      ref={scrollRef}
      onScroll={handleScroll}
      className={cn("h-full overflow-y-auto overflow-x-hidden", className)}
    >
      {/* 全行ぶんの高さを確保して、スクロールバーの長さを実データと一致させる。 */}
      <div style={{ height: layout.totalHeight }} className="relative w-full">
        <div
          className="absolute inset-x-0 grid gap-3"
          style={{
            transform: `translateY(${layout.offsetY}px)`,
            gridTemplateColumns: `repeat(${layout.columns}, minmax(0, 1fr))`,
          }}
        >
          {visiblePhotos.map((photo, offset) => {
            const index = layout.startIndex + offset;
            return (
              <PhotoCard
                key={photo.path}
                photo={photo}
                thumbnailSrc={thumbnailSrcFor?.(photo)}
                selected={selectedIds.has(photo.path)}
                onToggle={(target, shiftKey) => handleToggle(target, index, shiftKey)}
                onOpen={onOpen}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}
