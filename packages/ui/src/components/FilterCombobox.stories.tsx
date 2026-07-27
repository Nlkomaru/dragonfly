import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";

import { FilterCombobox, type FilterComboboxOption } from "./FilterCombobox";
import { Label } from "./ui/label";

const worlds: FilterComboboxOption[] = [
  { value: "wrld_11111111", label: "The Great Pug", keywords: ["wrld_11111111"], hint: "128" },
  { value: "wrld_22222222", label: "Just B Club", keywords: ["wrld_22222222"], hint: "64" },
  {
    value: "wrld_33333333",
    label: "とても長い名前のワールド ここから先は省略される想定です",
    keywords: ["wrld_33333333"],
    hint: "12",
  },
];

const meta = {
  title: "dragonfly/FilterCombobox",
  component: FilterCombobox,
  decorators: [
    (Story) => (
      <div className="w-72 bg-background p-6 text-foreground">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof FilterCombobox>;

export default meta;
type Story = StoryObj<typeof meta>;

/** 実際の使い方に合わせて、選択状態を持つラッパーで包む。 */
function Controlled({ initial }: { initial?: string }) {
  const [value, setValue] = useState<string | undefined>(initial);
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor="story-world" className="text-xs text-muted-foreground">
        ワールド
      </Label>
      <FilterCombobox
        id="story-world"
        value={value}
        onChange={setValue}
        options={worlds}
        placeholder="すべてのワールド"
        searchPlaceholder="ワールド名で検索"
        emptyText="一致するワールドがありません"
      />
    </div>
  );
}

export const Empty: Story = {
  args: { onChange: () => {}, options: worlds },
  render: () => <Controlled />,
};

export const Selected: Story = {
  args: { onChange: () => {}, options: worlds },
  render: () => <Controlled initial="wrld_11111111" />,
};

/** 候補に無い値（共有 URL から来た ID など）でも、空にせず生の値を出す。 */
export const UnknownValue: Story = {
  args: { onChange: () => {}, options: worlds },
  render: () => <Controlled initial="wrld_deadbeef" />,
};
