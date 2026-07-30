import type { Meta, StoryObj } from "@storybook/react-vite";

import { PhotoCard } from "./PhotoCard";
import { makePhoto, mockBlurhash, mockThumbnail } from "../stories/mocks";

const photo = makePhoto(0);
const uploadedPhoto = makePhoto(1);

const meta = {
  title: "dragonfly/PhotoCard",
  component: PhotoCard,
  decorators: [
    (Story) => (
      <div className="w-56 bg-background p-4 text-foreground">
        <Story />
      </div>
    ),
  ],
  args: { photo, thumbnailSrc: mockThumbnail(0), selected: false, onToggle: () => {} },
} satisfies Meta<typeof PhotoCard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Selected: Story = { args: { selected: true } };

/** 送信済みの写真にはクラウドのバッジが付く。 */
export const Uploaded: Story = {
  args: { photo: uploadedPhoto, thumbnailSrc: mockThumbnail(1) },
};

/** サムネイル生成が終わっていない状態。 */
export const LoadingThumbnail: Story = { args: { thumbnailSrc: undefined } };

/** サムネイル待ちでも BlurHash があれば、ぼかしで雰囲気だけ先に出せる。 */
export const LoadingWithBlurhash: Story = {
  args: { thumbnailSrc: undefined, blurhash: mockBlurhash(0) },
};

/** 右上に詳細（ⓘ）と拡大のボタンが出る状態。ホバーすると現れる。 */
export const WithOverlayButtons: Story = {
  args: { onInfo: () => {}, onPreview: () => {} },
};

/**
 * 削除ボタン付き。onDelete を渡したときだけ出る。確認は呼び出し側が行う。
 * 右上が最も混む組み合わせ（送信済みバッジ + ボタン 3 つ）で幅が足りるかを見る。
 */
export const WithDelete: Story = {
  args: {
    photo: uploadedPhoto,
    thumbnailSrc: mockThumbnail(1),
    onInfo: () => {},
    onPreview: () => {},
    onDelete: () => {},
  },
};

/** 閲覧モード。チェックボックスを出さず、カードのクリックで拡大する。 */
export const ViewOnly: Story = {
  args: { selectable: false, onInfo: () => {}, onPreview: () => {} },
};
