import tailwindcss from "@tailwindcss/vite";
import type { StorybookConfig } from "@storybook/react-vite";

const config: StorybookConfig = {
  stories: ["../src/**/*.stories.@(ts|tsx)"],
  framework: { name: "@storybook/react-vite", options: {} },
  // R2 のコミット単位パスへ置く際にサブパス配信になるため、環境変数で base を差し替える。
  viteFinal: async (config) => {
    config.base = process.env.STORYBOOK_BASE_PATH ?? "/";
    // styles.css の `@import "tailwindcss"` を解決するために v4 の Vite プラグインを足す。
    // React プラグインは @storybook/react-vite が既に入れているのでここでは追加しない。
    config.plugins = [...(config.plugins ?? []), tailwindcss()];
    return config;
  },
};

export default config;
