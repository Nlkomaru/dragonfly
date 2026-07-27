import type { Meta, StoryObj } from "@storybook/react-vite";

import { PhotoDetailDialog } from "./PhotoDetailDialog";
import { makePhoto, mockThumbnail } from "../stories/mocks";

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
    imageSrc: mockThumbnail(4),
    tags: ["集合写真", "夜景", "friends+"],
  },
} satisfies Meta<typeof PhotoDetailDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

/** 同席者もタグも無いケース。 */
export const WithoutPlayersAndTags: Story = {
  args: { photo: soloPhoto, imageSrc: mockThumbnail(5), tags: [] },
};

/** 原寸画像の読み込み待ち。 */
export const LoadingImage: Story = { args: { imageSrc: undefined } };

/** Web ギャラリー。タグを編集でき、画像から拡大表示に入れる。 */
export const Editable: Story = {
  args: {
    onTagsChange: () => {},
    tagSuggestions: ["集合写真", "夜景", "friends+", "ワールド巡り"],
    onPreview: () => {},
  },
};
