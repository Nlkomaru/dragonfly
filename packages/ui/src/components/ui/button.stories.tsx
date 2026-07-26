import type { Meta, StoryObj } from "@storybook/react-vite";
import { Upload } from "lucide-react";

import { Button } from "./button";

const meta = {
  title: "ui/Button",
  component: Button,
  args: { children: "アップロード" },
} satisfies Meta<typeof Button>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const Secondary: Story = { args: { variant: "secondary" } };
export const Outline: Story = { args: { variant: "outline" } };
export const Ghost: Story = { args: { variant: "ghost" } };
export const Destructive: Story = { args: { variant: "destructive" } };
export const WithIcon: Story = {
  args: {
    children: (
      <>
        <Upload />
        アップロード
      </>
    ),
  },
};
export const Sizes: Story = {
  render: () => (
    <div className="flex items-center gap-2">
      <Button size="sm">小</Button>
      <Button size="default">標準</Button>
      <Button size="lg">大</Button>
      <Button size="icon" aria-label="送信">
        <Upload />
      </Button>
    </div>
  ),
};
