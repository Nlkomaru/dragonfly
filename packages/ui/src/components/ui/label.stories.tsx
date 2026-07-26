import type { Meta, StoryObj } from "@storybook/react-vite";

import { Input } from "./input";
import { Label } from "./label";

const meta = {
  title: "ui/Label",
  component: Label,
  args: { children: "スクリーンショットの保存先" },
} satisfies Meta<typeof Label>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const WithInput: Story = {
  render: () => (
    <div className="flex w-72 flex-col gap-2">
      <Label htmlFor="root-dir">スクリーンショットの保存先</Label>
      <Input id="root-dir" defaultValue="C:\\Users\\niko\\Pictures\\VRChat" />
    </div>
  ),
};
