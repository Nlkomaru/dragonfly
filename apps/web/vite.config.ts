import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";

// Web 版は SSR あり。Cloudflare Workers 向けに出力する。
export default defineConfig({
  build: {
    rollupOptions: {
      // `cloudflare:workers` は Workers ランタイムが提供する組み込みモジュール。
      // バンドルせず、そのまま import として残す。
      external: ["cloudflare:workers"],
    },
  },
  plugins: [
    tanstackStart(),
    react(),
    tailwindcss(),
  ],
});
