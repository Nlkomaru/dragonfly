import { useMemo, useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import type { Photo } from "@dragonfly/core";

import { PhotoGrid } from "./PhotoGrid";
import { makePhotos, mockBlurhash, mockThumbnail } from "../stories/mocks";

const photos = makePhotos(1000);

/** path から作成時の index を引く。モックのサムネイル / BlurHash を選ぶのに使う。 */
const photoIndexByPath = new Map(photos.map((photo, index) => [photo.path, index]));
const indexOfPhoto = (path: string) => photoIndexByPath.get(path) ?? 0;

const meta = {
  title: "dragonfly/PhotoGrid",
  component: PhotoGrid,
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div className="h-[640px] bg-background p-4 text-foreground">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof PhotoGrid>;

export default meta;
type Story = StoryObj<typeof meta>;

/** 選択状態を持つデモ。実運用では Jotai のアトムがこの役目を担う。 */
function InteractiveGrid({ items }: { items: Photo[] }) {
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set());
  // path -> index を引くための対応表（範囲選択で使う）。
  const indexOf = useMemo(() => new Map(items.map((p, i) => [p.path, i])), [items]);

  return (
    <PhotoGrid
      photos={items}
      selectedIds={selectedIds}
      onToggle={(photo) => {
        setSelectedIds((prev) => {
          const next = new Set(prev);
          if (next.has(photo.path)) next.delete(photo.path);
          else next.add(photo.path);
          return next;
        });
      }}
      onRangeSelect={(from, to) => {
        setSelectedIds((prev) => {
          const next = new Set(prev);
          for (let i = from; i <= to; i += 1) next.add(items[i].path);
          return next;
        });
      }}
      thumbnailSrcFor={(photo) => mockThumbnail(indexOf.get(photo.path) ?? 0)}
    />
  );
}

/** 1000 枚。スクロールしても描画されるカードは可視行ぶんだけ。 */
export const ThousandPhotos: Story = {
  args: { photos, selectedIds: new Set<string>(), onToggle: () => {} },
  render: () => <InteractiveGrid items={photos} />,
};

/** サムネイル未生成のときはスケルトンが並ぶ。 */
export const WithoutThumbnails: Story = {
  args: { photos: photos.slice(0, 40), selectedIds: new Set<string>(), onToggle: () => {} },
};

/** サムネイル未生成でも BlurHash があれば、ぼかしが並んで空白にならない。 */
export const WithBlurhashPlaceholders: Story = {
  args: {
    photos: photos.slice(0, 40),
    selectedIds: new Set<string>(),
    onToggle: () => {},
    // 一覧の並びが分かるよう、サムネイルと同じ色相の BlurHash を返す。
    blurhashFor: (photo) => mockBlurhash(indexOfPhoto(photo.path)),
  },
};

/** 閲覧モードで削除ボタンを出したところ。カードにホバーすると右上に現れる。 */
export const WithDelete: Story = {
  args: {
    photos: photos.slice(0, 40),
    selectable: false,
    thumbnailSrcFor: (photo) => mockThumbnail(indexOfPhoto(photo.path)),
    onPreview: () => {},
    onDelete: () => {},
  },
};

/**
 * 一部の写真にだけ削除ボタンを出したところ。
 * デスクトップは「サーバー上の写真」を消すので、送信済みのカードにしか出さない。
 */
export const DeletableSubset: Story = {
  args: {
    photos: photos.slice(0, 40),
    selectedIds: new Set<string>(),
    onToggle: () => {},
    thumbnailSrcFor: (photo) => mockThumbnail(indexOfPhoto(photo.path)),
    onDelete: () => {},
    canDelete: (photo) => photo.uploaded,
  },
};
