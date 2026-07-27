import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";

import { TagEditor } from "./TagEditor";

const meta = {
  title: "dragonfly/TagEditor",
  component: TagEditor,
  decorators: [
    (Story) => (
      <div className="w-80 bg-background p-4 text-foreground">
        <Story />
      </div>
    ),
  ],
  args: {
    value: ["集合写真", "夜景"],
    onChange: () => {},
    suggestions: ["集合写真", "夜景", "friends+", "ワールド巡り"],
  },
} satisfies Meta<typeof TagEditor>;

export default meta;
type Story = StoryObj<typeof meta>;

/** 実際に追加・削除できる状態。 */
export const Default: Story = {
  render: (args) => {
    const [tags, setTags] = useState(args.value);
    return <TagEditor {...args} value={tags} onChange={setTags} />;
  },
};

/** まだ何も付いていない写真。 */
export const Empty: Story = { args: { value: [] } };

/** 保存中は入力を止める。 */
export const Pending: Story = { args: { pending: true } };
