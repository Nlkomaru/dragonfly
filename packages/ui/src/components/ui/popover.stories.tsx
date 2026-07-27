import type { Meta, StoryObj } from "@storybook/react-vite";

import { Popover, PopoverContent, PopoverTrigger } from "./popover";
import { Button } from "./button";

const meta = {
  title: "ui/Popover",
  component: Popover,
  parameters: { layout: "centered" },
} satisfies Meta<typeof Popover>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm">
          絞り込み
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="text-sm">
        撮影日時やワールドで絞り込みます。
      </PopoverContent>
    </Popover>
  ),
};
