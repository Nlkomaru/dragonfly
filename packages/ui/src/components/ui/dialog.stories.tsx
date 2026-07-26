import type { Meta, StoryObj } from "@storybook/react-vite";

import { Button } from "./button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "./dialog";

const meta = {
  title: "ui/Dialog",
  component: Dialog,
} satisfies Meta<typeof Dialog>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="outline">アップロードの確認</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>12 枚をアップロードします</DialogTitle>
          <DialogDescription>
            送信済みの写真は自動で除外されます。よろしいですか？
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="ghost">キャンセル</Button>
          </DialogClose>
          <Button>アップロード</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  ),
};

/** 初期状態から開いた表示。 */
export const Open: Story = {
  render: () => (
    <Dialog defaultOpen>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>アップロードが完了しました</DialogTitle>
          <DialogDescription>12 枚の写真をサーバーに送信しました。</DialogDescription>
        </DialogHeader>
      </DialogContent>
    </Dialog>
  ),
};
