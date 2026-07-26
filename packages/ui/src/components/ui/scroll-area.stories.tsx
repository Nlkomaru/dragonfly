import type { Meta, StoryObj } from "@storybook/react-vite";

import { ScrollArea } from "./scroll-area";

const meta = {
  title: "ui/ScrollArea",
  component: ScrollArea,
} satisfies Meta<typeof ScrollArea>;

export default meta;
type Story = StoryObj<typeof meta>;

/** 月一覧のような縦長リストを収める用途。 */
export const Vertical: Story = {
  render: () => (
    <ScrollArea className="h-56 w-56 rounded-md border border-border">
      <div className="flex flex-col gap-1 p-2 text-sm">
        {Array.from({ length: 40 }, (_, index) => (
          <span key={index} className="tabular-nums">
            2026-{String(12 - (index % 12)).padStart(2, "0")} / 項目 {index + 1}
          </span>
        ))}
      </div>
    </ScrollArea>
  ),
};
