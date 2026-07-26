import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";

// Web 版は SSR あり。Cloudflare Workers 向けに出力する。
export default defineConfig({
  plugins: [
    tanstackStart({ target: "cloudflare-module" }),
    react(),
    tailwindcss(),
  ],
});
