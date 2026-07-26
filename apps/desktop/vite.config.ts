import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";

// Tauri は静的な dist/ を読み込むため、このアプリは SSR せず SPA としてビルドする。
export default defineConfig({
  plugins: [
    // ファイルベースルーティング。src/routes/ から routeTree.gen.ts を生成する。
    tanstackRouter({ target: "react", autoCodeSplitting: true }),
    react(),
    tailwindcss(),
  ],
  // Tauri の devUrl と揃える。ポートが埋まっていたら黙って変えず失敗させる。
  server: {
    port: 1420,
    strictPort: true,
    // ビルド成果物の watch は不要なので Rust 側の変更で再読み込みしないようにする。
    watch: { ignored: ["**/src-tauri/**"] },
  },
  build: {
    // Tauri の WebView は新しめの Chromium/WebKit なので、ダウンレベル変換は最小限にする。
    target: process.env.TAURI_ENV_PLATFORM === "windows" ? "chrome105" : "safari13",
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
  },
});
