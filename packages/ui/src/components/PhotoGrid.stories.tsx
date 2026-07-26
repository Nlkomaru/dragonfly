import { useMemo, useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import type { Photo } from "@dragonfly/core";

import { PhotoGrid } from "./PhotoGrid";
import { makePhotos, mockThumbnail } from "../stories/mocks";

const photos = makePhotos(1000);

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
