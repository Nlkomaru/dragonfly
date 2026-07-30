// ユーザースコープの BlurHash API。/api/v1/users/:id/blurhashes にぶら下がる。
//
// アップロード時にデスクトップが計算して載せてくるのが本筋で、ここはその取りこぼしを
// 後から埋めるための経路。既にアップロード済みの写真はサムネイル (AVIF) をデコードできる
// ブラウザ側で計算するしかないので、パレットと同じく「クライアントが計算してサーバーは置くだけ」。
//
// 一覧の GET は用意していない。blurhash は ApiPhoto にそのまま載るので、
// クライアントは写真一覧の blurhash === null を見れば未計算の写真を割り出せる。
//
// `:id` の扱いは写真 API と同じで、解決は resolveOwner が一手に引き受ける。

import { Hono } from "hono";
import { describeRoute, resolver, validator } from "hono-openapi";
import {
  ErrorResponseSchema,
  PutBlurhashesRequestSchema,
  PutBlurhashesResponseSchema,
  UserParamSchema,
} from "./schemas";
import type { ApiEnv } from "./middleware";
import { requireAuth, resolveOwner } from "./middleware";
import { upsertBlurhashes } from "../server/photos";

/** 認証エラー / 所有者不一致は全ルート共通。写真 API と同じ内容を並べる。 */
const commonErrorResponses = {
  401: {
    description: "認証されていない",
    content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
  },
  403: {
    description: "他人のユーザー ID を指定した",
    content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
  },
};

// basePath は handler.ts 側で与える。ここは :id 以下だけを組み立てる。
const blurhashesRouter = new Hono<ApiEnv>();

// Hono の use() はここより下のルートにしか効かない。
// 署名だけで開ける経路は無いので、必ずすべてのルートより前に置く。
blurhashesRouter.use("/users/:id/*", requireAuth, resolveOwner);

blurhashesRouter.put(
  "/users/:id/blurhashes",
  describeRoute({
    tags: ["blurhashes"],
    summary: "BlurHash の一括保存",
    description:
      "photo_id ごとに photos.blurhash を書き換える。既にあれば上書きするので、" +
      "計算し直した値をそのまま送ってよい。" +
      "呼び出し元が所有していない写真 ID は黙って捨てる（他人の写真の存在を漏らさないため、" +
      "404 にはせず saved の件数だけが減る）。",
    responses: {
      200: {
        description: "実際に保存できた件数",
        content: { "application/json": { schema: resolver(PutBlurhashesResponseSchema) } },
      },
      400: {
        description: "BlurHash の形式が不正、または件数が上限を超えている",
        content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
      },
      ...commonErrorResponses,
    },
  }),
  validator("param", UserParamSchema),
  validator("json", PutBlurhashesRequestSchema),
  async (c) => {
    const { blurhashes } = c.req.valid("json");
    const saved = await upsertBlurhashes(c.get("db"), c.get("ownerId"), blurhashes);
    return c.json({ saved });
  },
);

export default blurhashesRouter;
