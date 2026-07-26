import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { buildMonthBuckets } from "@dragonfly/core";
import { Settings } from "lucide-react";

import { Button } from "./ui/button";
import { MonthSidebar } from "./MonthSidebar";
import { makePhotos } from "../stories/mocks";

const buckets = buildMonthBuckets(makePhotos(400));

const meta = {
  title: "dragonfly/MonthSidebar",
  component: MonthSidebar,
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div className="h-[520px] bg-background text-foreground">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof MonthSidebar>;

export default meta;
type Story = StoryObj<typeof meta>;

/** 選択状態を持たせた対話デモ。実際の選択管理は各アプリ側にある。 */
function InteractiveSidebar() {
  const [activeMonth, setActiveMonth] = useState<string | null>(buckets[0]?.month ?? null);
  return (
    <MonthSidebar
      buckets={buckets}
      activeMonth={activeMonth}
      onSelectMonth={setActiveMonth}
      footer={
        <Button variant="ghost" size="sm" className="w-full justify-start">
          <Settings />
          設定
        </Button>
      }
    />
  );
}

export const Default: Story = {
  args: { buckets, activeMonth: buckets[0]?.month ?? null, onSelectMonth: () => {} },
  render: () => <InteractiveSidebar />,
};

export const WithoutFooter: Story = {
  args: { buckets, activeMonth: null, onSelectMonth: () => {} },
};

export const Empty: Story = {
  args: { buckets: [], activeMonth: null, onSelectMonth: () => {} },
};
