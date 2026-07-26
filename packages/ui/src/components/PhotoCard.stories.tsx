import type { Meta, StoryObj } from "@storybook/react-vite";

import { PhotoCard } from "./PhotoCard";
import { makePhoto, mockThumbnail } from "../stories/mocks";

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

export const WithDetailButton: Story = { args: { onOpen: () => {} } };
