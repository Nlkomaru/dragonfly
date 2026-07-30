import type { Meta, StoryObj } from "@storybook/react-vite";

import { PhotoDetailDialog } from "./PhotoDetailDialog";
import { makePhoto } from "../stories/mocks";

const photo = makePhoto(4);
const soloPhoto = makePhoto(5);

const meta = {
  title: "dragonfly/PhotoDetailDialog",
  component: PhotoDetailDialog,
  parameters: { layout: "fullscreen" },
  args: {
    photo,
    open: true,
    onOpenChange: () => {},
    tags: ["集合写真", "夜景", "friends+"],
  },
} satisfies Meta<typeof PhotoDetailDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

/** 同席者もタグも無いケース。 */
export const WithoutPlayersAndTags: Story = {
  args: { photo: soloPhoto, tags: [] },
};

/** Web ギャラリー。タグを編集でき、拡大表示にも入れる。 */
export const Editable: Story = {
  args: {
    onTagsChange: () => {},
    tagSuggestions: ["集合写真", "夜景", "friends+", "ワールド巡り"],
    onPreview: () => {},
  },
};

/** 削除できる状態。拡大の隣にゴミ箱が並ぶ。確認は呼び出し側が出す。 */
export const WithDelete: Story = {
  args: { onPreview: () => {}, onDelete: () => {} },
};
