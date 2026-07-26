import type { Meta, StoryObj } from "@storybook/react-vite";
import { FolderSearch, ImageOff } from "lucide-react";

import { Button } from "./ui/button";
import { EmptyState } from "./EmptyState";

const meta = {
  title: "dragonfly/EmptyState",
  component: EmptyState,
  decorators: [
    (Story) => (
      <div className="h-80 bg-background text-foreground">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof EmptyState>;

export default meta;
type Story = StoryObj<typeof meta>;

export const NoPhotosInMonth: Story = {
  args: {
    icon: ImageOff,
    title: "この月には写真がありません",
    description: "別の月を選ぶか、スクリーンショットの保存先を確認してください。",
  },
};

export const WithAction: Story = {
  args: {
    icon: FolderSearch,
    title: "スクリーンショットが見つかりません",
    description: "VRChat の保存先フォルダを設定してから再スキャンしてください。",
    action: <Button size="sm">再スキャン</Button>,
  },
};
