import type { Meta, StoryObj } from "@storybook/react-vite";

import { Button } from "./button";
import { Toaster, toast } from "./sonner";

const meta = {
  title: "ui/Toaster",
  component: Toaster,
} satisfies Meta<typeof Toaster>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => (
    <div className="flex gap-2">
      <Toaster />
      <Button variant="outline" onClick={() => toast.success("12 枚をアップロードしました")}>
        成功トースト
      </Button>
      <Button variant="outline" onClick={() => toast.error("メタデータの読み取りに失敗しました")}>
        失敗トースト
      </Button>
    </div>
  ),
};
