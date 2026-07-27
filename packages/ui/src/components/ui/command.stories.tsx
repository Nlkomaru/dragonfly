import type { Meta, StoryObj } from "@storybook/react-vite";

import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "./command";

const meta = {
  title: "ui/Command",
  component: Command,
  parameters: { layout: "centered" },
} satisfies Meta<typeof Command>;

export default meta;
type Story = StoryObj<typeof meta>;

/** 入力で絞り込める一覧。TagEditor はこれを Popover に載せている。 */
export const Default: Story = {
  render: () => (
    <Command className="w-64 rounded-md border">
      <CommandInput placeholder="タグを検索" />
      <CommandList>
        <CommandEmpty>一致するタグがありません</CommandEmpty>
        <CommandGroup heading="タグ">
          <CommandItem value="集合写真">集合写真</CommandItem>
          <CommandItem value="夜景">夜景</CommandItem>
          <CommandItem value="ワールド巡り">ワールド巡り</CommandItem>
        </CommandGroup>
      </CommandList>
    </Command>
  ),
};
