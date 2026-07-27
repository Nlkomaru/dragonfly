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
