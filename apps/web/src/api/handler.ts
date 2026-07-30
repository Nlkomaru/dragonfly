// /api/* の入口。SSR と同じ Worker の中で Hono が API 一式を持つ。
//
// 内訳:
//   /api/auth/*   better-auth（Discord ログイン、セッション、API キーの発行 / 失効）
//   /api/v1/**    dragonfly の API（ユーザースコープ）
//   /api/openapi  OpenAPI 3.1 の仕様
//   /api/scalar   Scalar による閲覧 UI

import type { APIError } from "better-auth/api";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { openAPIRouteHandler } from "hono-openapi";
import blurhashesRouter from "./blurhashes";
import openAPIRouter from "./openapi";
import palettesRouter from "./palettes";
import photosRouter from "./photos";
import { MeResponseSchema } from "./schemas";
import { describeRoute, resolver } from "hono-openapi";
import type { ApiEnv } from "./middleware";
import { requireAuth } from "./middleware";
import { getAuth } from "../server/context";

const handler = new Hono<ApiEnv>().basePath("/api");

/**
 * 例外を JSON のエラー応答に揃える。
 * ここを通さないと Hono の既定でプレーンテキストが返り、
 * デスクトップ側の JSON デコードが落ちる。
 */
handler.onError((error, c) => {
  if (error instanceof HTTPException) {
    return c.json({ error: error.message }, error.status);
  }
  // better-auth（セッション / API キーの検証）が投げる例外は自前のステータスを持つ。
  // これを拾わないと 401 も 429 もすべて 500 になり、原因が分からなくなる。
  //
  // instanceof ではなく形で判定する。better-auth の依存が重複解決されると
  // 例外のクラスとここで import したクラスが別物になり、instanceof が成立しない。
  const status = (error as { statusCode?: unknown }).statusCode;
  if (typeof status === "number" && status >= 400 && status < 600) {
    const message = (error as APIError).body?.message ?? error.message;
    return c.json({ error: message }, status as ContentfulStatusCode);
  }
  console.error("unhandled api error", error);
  return c.json({ error: "internal error" }, 500);
});

// --- better-auth -----------------------------------------------------------
// サインイン、コールバック、セッション、API キーの CRUD がすべてこの下にある。
// basePath を "/api/auth" にしてあるので、パスはそのまま渡してよい。
handler.on(["GET", "POST"], "/auth/*", (c) => getAuth(c.env).handler(c.req.raw));

// --- 接続テスト ------------------------------------------------------------
handler.get(
  "/v1/me",
  describeRoute({
    tags: ["meta"],
    summary: "呼び出し元の確認",
    description:
      "デスクトップの設定画面が「鍵が無効 (401)」と「サーバーに届かない (通信エラー)」を区別するために使う。",
    responses: {
      200: {
        description: "認証されたユーザー",
        content: { "application/json": { schema: resolver(MeResponseSchema) } },
      },
      401: { description: "認証されていない" },
    },
  }),
  requireAuth,
  (c) => c.json({ userId: c.get("callerId"), displayName: c.get("callerName") }),
);

// --- dragonfly の API ------------------------------------------------------
handler.route("/v1", photosRouter);
handler.route("/v1", palettesRouter);
handler.route("/v1", blurhashesRouter);

// --- ドキュメント ----------------------------------------------------------
openAPIRouter.get(
  "/openapi",
  openAPIRouteHandler(handler, {
    documentation: {
      info: {
        title: "dragonfly API",
        version: "1.0.0",
        description:
          "VRChat のスクリーンショットを保管する dragonfly のサーバー API。\n\n" +
          "認証は 2 通り。ブラウザは Discord ログインで得たセッション Cookie、" +
          "デスクトップアプリは `Authorization: Bearer dfly_...` の API キー。" +
          "どちらも同じユーザーに解決される。\n\n" +
          "パスの `:id` には better-auth のユーザー ID か、呼び出し元を指す別名 `me` を渡す。" +
          "他人の ID を指定すると 403 になる。",
      },
      components: {
        securitySchemes: {
          apiKey: {
            type: "http",
            scheme: "bearer",
            description: "デスクトップアプリ用の API キー (`dfly_` で始まる)",
          },
          session: {
            type: "apiKey",
            in: "cookie",
            name: "better-auth.session_token",
            description: "Discord ログインで発行されるセッション Cookie",
          },
        },
      },
      security: [{ apiKey: [] }, { session: [] }],
    },
  }),
);

handler.route("/", openAPIRouter);

export default handler;
