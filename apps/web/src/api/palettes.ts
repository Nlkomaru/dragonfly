// ユーザースコープのカラーパレット API。/api/v1/users/:id/palettes にぶら下がる。
//
// パレットの抽出はサムネイル (AVIF) をデコードできるブラウザ側でしか行えないので、
// サーバーは「クライアントが抽出した結果の置き場」に徹する。
// `:id` の扱いは写真 API と同じで、解決は resolveOwner が一手に引き受ける。

import { Hono } from "hono";
import { describeRoute, resolver, validator } from "hono-openapi";
import {
  ErrorResponseSchema,
  ListPalettesResponseSchema,
  PutPalettesRequestSchema,
  PutPalettesResponseSchema,
  UserParamSchema,
} from "./schemas";
import type { ApiEnv } from "./middleware";
import { requireAuth, resolveOwner } from "./middleware";
import { listPalettes, upsertPalettes } from "../server/palettes";

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
const palettesRouter = new Hono<ApiEnv>();

// Hono の use() はここより下のルートにしか効かない。
// 署名だけで開ける経路は無いので、必ずすべてのルートより前に置く。
palettesRouter.use("/users/:id/*", requireAuth, resolveOwner);

palettesRouter.get(
  "/users/:id/palettes",
  describeRoute({
    tags: ["palettes"],
    summary: "保存済みカラーパレットの一覧",
    description:
      "そのユーザーの全パレットを一度に返す。ページングは無い。" +
      "写真一覧と突き合わせて「まだ抽出していない写真」「版が古い写真」を割り出し、" +
      "クライアントが抽出して PUT で埋める使い方を想定している。",
    responses: {
      200: {
        description: "このユーザーの全パレット",
        content: { "application/json": { schema: resolver(ListPalettesResponseSchema) } },
      },
      ...commonErrorResponses,
    },
  }),
  validator("param", UserParamSchema),
  async (c) => {
    return c.json({ palettes: await listPalettes(c.get("db"), c.get("ownerId")) });
  },
);

palettesRouter.put(
  "/users/:id/palettes",
  describeRoute({
    tags: ["palettes"],
    summary: "カラーパレットの一括保存",
    description:
      "photo_id ごとに upsert する。既にあれば上書きするので、再抽出しても行は増えない。" +
      "呼び出し元が所有していない写真 ID は黙って捨てる（他人の写真の存在を漏らさないため、" +
      "404 にはせず saved の件数だけが減る）。",
    responses: {
      200: {
        description: "実際に保存できた件数",
        content: { "application/json": { schema: resolver(PutPalettesResponseSchema) } },
      },
      400: {
        description: "パレットの形式が不正、または件数が上限を超えている",
        content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
      },
      ...commonErrorResponses,
    },
  }),
  validator("param", UserParamSchema),
  validator("json", PutPalettesRequestSchema),
  async (c) => {
    const { palettes } = c.req.valid("json");
    const saved = await upsertPalettes(c.get("db"), c.get("ownerId"), palettes);
    return c.json({ saved });
  },
);

export default palettesRouter;
