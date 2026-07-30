import type { Meta, StoryObj } from "@storybook/react-vite";

import { BlurhashImage } from "./BlurhashImage";
import { mockBlurhash, mockThumbnail } from "../stories/mocks";

const meta = {
  title: "dragonfly/BlurhashImage",
  component: BlurhashImage,
  decorators: [
    (Story) => (
      // 大きさは親が決める作りなので、正方形の枠を用意して中に置く。
      <div className="bg-background p-4 text-foreground">
        <div className="size-56 overflow-hidden rounded-lg border">
          <Story />
        </div>
      </div>
    ),
  ],
  args: { alt: "サンプル写真" },
} satisfies Meta<typeof BlurhashImage>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * 読み込み前。BlurHash のぼかしだけが見えている状態。
 * データ URI のサムネイルは即座に読み込まれてしまうので、src を渡さずに再現する。
 */
export const BeforeLoad: Story = {
  args: { blurhash: mockBlurhash(0), src: undefined },
};

/** 読み込み後。ぼかしの上に画像がフェードインして乗る。 */
export const Loaded: Story = {
  args: { blurhash: mockBlurhash(0), src: mockThumbnail(0) },
};

/** BlurHash が無いとき（デスクトップのローカル一覧など）。従来どおりスケルトンになる。 */
export const WithoutBlurhash: Story = {
  args: { blurhash: null, src: undefined },
};

/** 壊れた BlurHash。例外で描画を落とさず、スケルトンに落ちる。 */
export const InvalidBlurhash: Story = {
  args: { blurhash: "not-a-blurhash", src: undefined },
};

/** 拡大表示のように、切り抜かずに収めたいとき。 */
export const Contain: Story = {
  args: {
    blurhash: mockBlurhash(3),
    src: mockThumbnail(3),
    imgClassName: "object-contain",
  },
};
