import type { Meta, StoryObj } from "@storybook/react-vite";
import { Check } from "lucide-react";

import { Badge } from "./badge";

const meta = {
  title: "ui/Badge",
  component: Badge,
  args: { children: "2026-06" },
} satisfies Meta<typeof Badge>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const Secondary: Story = { args: { variant: "secondary" } };
export const Outline: Story = { args: { variant: "outline" } };
export const Destructive: Story = { args: { variant: "destructive" } };
export const WithIcon: Story = {
  args: {
    children: (
      <>
        <Check />
        送信済み
      </>
    ),
  },
};
