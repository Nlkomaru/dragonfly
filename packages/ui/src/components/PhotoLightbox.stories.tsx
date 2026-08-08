import type { Meta, StoryObj } from "@storybook/react-vite";

import { PhotoLightbox } from "./PhotoLightbox";
import { makePhoto, mockThumbnail } from "../stories/mocks";

const photo = makePhoto(2);

const meta = {
  title: "dragonfly/PhotoLightbox",
  component: PhotoLightbox,
  parameters: { layout: "fullscreen" },
  args: {
    photo,
    open: true,
    onOpenChange: () => {},
    imageSrc: mockThumbnail(2),
  },
} satisfies Meta<typeof PhotoLightbox>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

/** 前後の写真へ移動できる状態。左右キーでも動く。 */
export const WithNavigation: Story = {
  args: { onPrev: () => {}, onNext: () => {} },
};

/** 原寸画像の読み込み待ち。 */
export const LoadingImage: Story = { args: { imageSrc: undefined } };

/** Web ギャラリー。画像を左上に寄せ、右と下に情報を出してタグも編集できる。 */
export const WithInfo: Story = {
  args: {
    photo: makePhoto(4),
    imageSrc: mockThumbnail(4),
    onPrev: () => {},
    onNext: () => {},
    showInfo: true,
    tags: ["集合写真", "夜景"],
    onTagsChange: () => {},
    tagSuggestions: ["集合写真", "夜景", "friends+", "ワールド巡り"],
  },
};

/** 削除できる状態。閉じるボタンの隣にゴミ箱が並ぶ。確認は呼び出し側が出す。 */
export const WithDelete: Story = {
  args: { onPrev: () => {}, onNext: () => {}, onDelete: () => {} },
};

/** 回転できる状態。左右の回転ボタンが閉じるボタンの並びに出る。 */
export const WithRotate: Story = {
  args: { onPrev: () => {}, onNext: () => {}, onDelete: () => {}, onRotate: () => {} },
};

/** 回転の処理中。回転・削除ボタンが無効になり、右回転側がスピナーになる。 */
export const RotatePending: Story = {
  args: { onDelete: () => {}, onRotate: () => {}, rotatePending: true },
};
