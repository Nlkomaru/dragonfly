import type { Meta, StoryObj } from "@storybook/react-vite";
import { Upload } from "lucide-react";

import { Button } from "./ui/button";
import { SelectionActionBar } from "./SelectionActionBar";
import { makePhotos } from "../stories/mocks";

const photos = makePhotos(400);
// 先頭 7 枚は 2026-06 に収まる（3時間刻みで遡るため）。内訳バッジは出ない。
const singleMonth = photos.slice(0, 7);
// 月をまたぐ選択。内訳バッジの確認用。
const multiMonth = [...photos.slice(0, 8), ...photos.slice(300, 320)];

const meta = {
  title: "dragonfly/SelectionActionBar",
  component: SelectionActionBar,
  decorators: [
    (Story) => (
      <div className="flex justify-center bg-background p-8 text-foreground">
        <Story />
      </div>
    ),
  ],
  args: {
    onClear: () => {},
    actions: (
      <Button size="sm">
        <Upload />
        アップロード
      </Button>
    ),
  },
} satisfies Meta<typeof SelectionActionBar>;

export default meta;
type Story = StoryObj<typeof meta>;

export const SingleMonth: Story = { args: { selectedPhotos: singleMonth } };

export const MultipleMonths: Story = { args: { selectedPhotos: multiMonth } };

/** 選択が空のときは何も描画しない。 */
export const EmptySelection: Story = { args: { selectedPhotos: [] } };
