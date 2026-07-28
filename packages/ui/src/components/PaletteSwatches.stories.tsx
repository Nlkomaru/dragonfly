import type { Meta, StoryObj } from "@storybook/react-vite";

import { PaletteSwatches } from "./PaletteSwatches";

const meta = {
  title: "dragonfly/PaletteSwatches",
  component: PaletteSwatches,
  decorators: [
    (Story) => (
      <div className="w-72 bg-background p-4 text-foreground">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof PaletteSwatches>;

export default meta;
type Story = StoryObj<typeof meta>;

/** 夜の街並みのような、暗色に寄ったパレット。 */
export const NightScene: Story = {
  args: {
    swatches: [
      { hex: "#1b2033", ratio: 0.46 },
      { hex: "#3c4a6b", ratio: 0.24 },
      { hex: "#7d8fb3", ratio: 0.16 },
      { hex: "#c9a227", ratio: 0.09 },
      { hex: "#e8e3d5", ratio: 0.05 },
    ],
  },
};

/** ほぼ単色の写真。代表色が足りず ratio: 0 で埋まったケース。 */
export const NearlyMonochrome: Story = {
  args: {
    swatches: [
      { hex: "#f2f2f0", ratio: 0.93 },
      { hex: "#d8d8d4", ratio: 0.07 },
      { hex: "#000000", ratio: 0 },
      { hex: "#000000", ratio: 0 },
      { hex: "#000000", ratio: 0 },
    ],
  },
};

/** 有効な画素が無く、全色 ratio: 0 になったケース。帯の高さだけが残る。 */
export const Empty: Story = {
  args: {
    swatches: [
      { hex: "#000000", ratio: 0 },
      { hex: "#000000", ratio: 0 },
      { hex: "#000000", ratio: 0 },
      { hex: "#000000", ratio: 0 },
      { hex: "#000000", ratio: 0 },
    ],
  },
};

/** 一覧に並べたときの見え方。太さを変えて使うこともできる。 */
export const InList: Story = {
  args: { swatches: [] },
  render: () => (
    <div className="flex flex-col gap-3">
      <PaletteSwatches
        swatches={[
          { hex: "#2f6f4e", ratio: 0.5 },
          { hex: "#8fbf7f", ratio: 0.3 },
          { hex: "#f0e6c8", ratio: 0.2 },
        ]}
      />
      <PaletteSwatches
        className="h-6 rounded-md"
        swatches={[
          { hex: "#7a2f4e", ratio: 0.4 },
          { hex: "#c96f8f", ratio: 0.35 },
          { hex: "#f4d7e2", ratio: 0.25 },
        ]}
      />
    </div>
  ),
};
