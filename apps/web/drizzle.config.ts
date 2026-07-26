import { defineConfig } from "drizzle-kit";

// マイグレーション「生成」専用の設定。
// 出力先を migrations/ にしているのは、`wrangler d1 migrations apply dragonfly --remote`
// （.github/workflows/db-migrate.yml が叩く）が読むディレクトリがそこだから。
// drizzle-kit は同じディレクトリに meta/ も作るが、wrangler は *.sql しか見ないので共存できる。
//
// driver は指定しない。`driver: "d1-http"` にすると Cloudflare の API トークンを要求され、
// 生成するだけの用途では余計な資格情報が必要になってしまう。
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/db/schema.ts",
  out: "./migrations",
});
