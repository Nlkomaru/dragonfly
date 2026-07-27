import type { Meta, StoryObj } from "@storybook/react-vite";

import { UploadProgressBar } from "./UploadProgressBar";

const meta = {
  title: "dragonfly/UploadProgressBar",
  component: UploadProgressBar,
  decorators: [
    (Story) => (
      <div className="bg-background text-foreground">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof UploadProgressBar>;

export default meta;
type Story = StoryObj<typeof meta>;

export const InProgress: Story = {
  args: {
    processed: 37,
    total: 120,
    succeeded: 36,
    failed: 1,
    currentName: "VRChat_2026-05-27_03-31-44.098_3840x2160.png",
    done: false,
  },
};

export const Completed: Story = {
  args: {
    processed: 120,
    total: 120,
    succeeded: 120,
    failed: 0,
    done: true,
    onDismiss: () => {},
  },
};

export const CompletedWithFailures: Story = {
  args: {
    processed: 120,
    total: 120,
    succeeded: 113,
    failed: 7,
    done: true,
    onDismiss: () => {},
  },
};
