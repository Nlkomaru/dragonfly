// /api/* をまるごと Hono に委譲するキャッチオールルート。
//
// TanStack Start のサーバールートは 1 つだけ置き、パスの振り分けは Hono に任せる。
// こうしておくと SSR と API が同じ Worker に同居したまま、
// API 側は Hono / hono-openapi の作法だけで書ける。

import { createFileRoute } from "@tanstack/react-router";
import { env } from "cloudflare:workers";
import handler from "../../api/handler";

/** Hono に渡す実行コンテキスト。バインディングは env から取る。 */
const dispatch = ({ request }: { request: Request }) => handler.fetch(request, env);

export const Route = createFileRoute("/api/$")({
  server: {
    handlers: {
      GET: dispatch,
      POST: dispatch,
      PUT: dispatch,
      PATCH: dispatch,
      DELETE: dispatch,
      OPTIONS: dispatch,
      HEAD: dispatch,
    },
  },
});
