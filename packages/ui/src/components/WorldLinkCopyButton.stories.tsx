import type { Meta, StoryObj } from "@storybook/react-vite";

import { WorldLinkCopyButton } from "./WorldLinkCopyButton";

const meta = {
  title: "dragonfly/WorldLinkCopyButton",
  component: WorldLinkCopyButton,
  args: {
    worldId: "wrld_example",
    worldName: "Stratocubulus",
    authorName: "ikenadro",
  },
} satisfies Meta<typeof WorldLinkCopyButton>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const WithoutAuthor: Story = {
  args: { authorName: null },
};
