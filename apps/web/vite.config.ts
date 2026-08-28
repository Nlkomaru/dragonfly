import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";

// Web 版は SSR あり。Cloudflare Workers 向けに出力する。
export default defineConfig({
  ssr: {
    // better-auth は `import("@opentelemetry/api")` を動的 import し、
    // 失敗したら noop 実装に落ちる作りになっている。
    // ところが外部化したままだと Workers 上でこの指定子が解決できず、
    // 例外ではなく空オブジェクトが返る。すると `.catch()` が発火しないまま
    // `SpanStatusCode` が undefined の API を掴んでしまう。
    // better-auth は OAuth のリダイレクトを `throw ctx.redirect(url)` で表現するため、
    // その計測処理で `SpanStatusCode.ERROR` を読んで TypeError になり、
    // 正常なリダイレクトがまるごと 500 に化ける。必ずバンドルに含めること。
    noExternal: ["@opentelemetry/api"],
  },
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
