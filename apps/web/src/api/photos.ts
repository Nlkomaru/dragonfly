// ユーザースコープの写真 API。すべて /api/v1/users/:id/photos 配下にぶら下がる。
//
// `:id` は better-auth のユーザー ID か、呼び出し元を指す別名 `me`。
// 解決は resolveOwner が一手に引き受け、ここから先は ownerId しか見ない。

import type { UploadPhotoResponse } from "@dragonfly/core";
import { waitUntil } from "cloudflare:workers";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { describeRoute, resolver, validator } from "hono-openapi";
import { z } from "zod";
import {
  ApiPhotoSchema,
  CheckPhotosRequestSchema,
  CheckPhotosResponseSchema,
  ErrorResponseSchema,
  ListFacetsResponseSchema,
  ListPhotosQuerySchema,
  ListPhotosResponseSchema,
  ListTagsResponseSchema,
  RotatePhotoRequestSchema,
  PutPhotoTagsRequestSchema,
  PutPhotoTagsResponseSchema,
  UploadPhotoMetadataSchema,
  UploadPhotoResponseSchema,
  UserParamSchema,
  UserPhotoParamSchema,
} from "./schemas";
import type { ApiEnv } from "./middleware";
import { requireAuth, requireAuthOrSignedPhoto, resolveOwner } from "./middleware";
import {
  applyPhotoRotation,
  deletePhoto,
  deletePhotoBySourceHash,
  findPhotoKeys,
  findUploadedHashes,
  getPhoto,
  insertPhoto,
  listFacets,
  listPhotos,
  listTags,
  photoKeys,
  setPhotoTags,
} from "../server/photos";
import { PhotoObjectNotFound, streamPhotoObject } from "../server/r2";

/** 認証エラー / 所有者不一致は全ルート共通なので、ドキュメントもまとめて使い回す。 */
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

const notFoundResponse = {
  404: {
    description: "写真が見つからない",
    content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
  },
};

/**
 * ハッシュ指定の削除だけが持つパスパラメータ。
 * 形は schemas.ts の sha256Schema と同じ（変換前 PNG の SHA-256、16 進小文字 64 文字）だが、
 * あちらは非公開なのでここで書き下している。使うルートが 1 本しかないため共有もしていない。
 */
const UserPhotoHashParamSchema = UserParamSchema.extend({
  sourceSha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/, "must be a lowercase hex sha-256")
    .meta({ description: "変換前 PNG の SHA-256", example: "a".repeat(64) }),
});

// basePath は handler.ts 側で与える。ここは :id 以下だけを組み立てる。
const photosRouter = new Hono<ApiEnv>();

// ---------------------------------------------------------------------------
// 画像配信: 署名 URL またはセッション / API キー。
// グローバルな requireAuth には載せない（署名だけで <img src> から読めるようにする）。
// ---------------------------------------------------------------------------
for (const variant of ["image", "thumb"] as const) {
  photosRouter.get(
    `/users/:id/photos/:photoId/${variant}`,
    describeRoute({
      tags: ["photos"],
      summary: variant === "image" ? "画像本体 (AVIF) の配信" : "サムネイル (AVIF) の配信",
      description:
        "R2 から直接ストリームする。" +
        "認可は (1) クエリの HMAC 署名 (exp + sig) か (2) セッション Cookie / API キー。" +
        "一覧が返す url / thumbUrl は短い有効期限付きの署名 URL なので、" +
        "ブラウザの <img src> から Authorization 無しで読める。" +
        "デスクトップは従来どおり Bearer だけでアクセスできる。",
      responses: {
        200: {
          description: "AVIF のバイト列",
          content: { "image/avif": { schema: { type: "string", format: "binary" } } },
        },
        ...notFoundResponse,
        ...commonErrorResponses,
      },
    }),
    validator("param", UserPhotoParamSchema),
    requireAuthOrSignedPhoto(variant),
    async (c) => {
      const signedExp = c.get("signedPhotoExp");
      try {
        return await streamPhotoObject(
          c.get("db"),
          c.get("photos"),
          c.get("ownerId"),
          c.req.param("photoId"),
          variant,
          // 署名経由なら残り寿命で public キャッシュ。資格情報経由は private 長期。
          signedExp !== undefined
            ? { mode: "signed", exp: signedExp }
            : { mode: "private" },
        );
      } catch (error) {
        if (error instanceof PhotoObjectNotFound) {
          throw new HTTPException(404, { message: error.message });
        }
        throw error;
      }
    },
  );
}

// ---------------------------------------------------------------------------
// 一覧・詳細・アップロード・削除: 認証必須（署名では開けない）。
// ---------------------------------------------------------------------------
photosRouter.use("/users/:id/*", requireAuth, resolveOwner);

photosRouter.get(
  "/users/:id/photos",
  describeRoute({
    tags: ["photos"],
    summary: "写真の一覧",
    description:
      "撮影日時の新しい順に返す。並びは (takenAt DESC, id DESC) で、同時刻でも順序が決まる。" +
      "各写真の url / thumbUrl は HMAC 署名付きの短い有効期限 URL。",
    responses: {
      200: {
        description: "写真の一覧と次ページのカーソル",
        content: { "application/json": { schema: resolver(ListPhotosResponseSchema) } },
      },
      ...commonErrorResponses,
    },
  }),
  validator("param", UserParamSchema),
  validator("query", ListPhotosQuerySchema),
  async (c) => {
    const query = c.req.valid("query");
    const result = await listPhotos(
      c.get("db"),
      c.get("ownerId"),
      {
        worldId: query.world,
        playerId: query.player,
        tag: query.tag,
        from: query.from,
        to: query.to,
        cursor: query.cursor,
      },
      c.env.BETTER_AUTH_SECRET,
    );
    return c.json(result);
  },
);

photosRouter.post(
  "/users/:id/photos",
  describeRoute({
    tags: ["photos"],
    summary: "写真のアップロード",
    description:
      "multipart/form-data。`image` は AVIF 本体、`thumb` はグリッド用サムネイル（省略可）、" +
      "`metadata` は UploadPhotoMetadata の JSON 文字列。" +
      "(ownerId, sourceSha256) について冪等で、再送しても行は増えず deduplicated: true が返る。",
    requestBody: {
      required: true,
      content: {
        "multipart/form-data": {
          schema: {
            type: "object",
            required: ["image", "metadata"],
            properties: {
              image: { type: "string", format: "binary", description: "AVIF 本体" },
              thumb: { type: "string", format: "binary", description: "AVIF サムネイル" },
              metadata: { type: "string", description: "UploadPhotoMetadata の JSON" },
            },
          },
        },
      },
    },
    responses: {
      201: {
        description: "新規に登録した",
        content: { "application/json": { schema: resolver(UploadPhotoResponseSchema) } },
      },
      200: {
        description: "同じ写真が既にあった（冪等）",
        content: { "application/json": { schema: resolver(UploadPhotoResponseSchema) } },
      },
      400: {
        description: "パートが足りない、または metadata が不正",
        content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
      },
      ...commonErrorResponses,
    },
  }),
  validator("param", UserParamSchema),
  async (c) => {
    const ownerId = c.get("ownerId");
    const form = await c.req.formData();
    const image = form.get("image");
    const thumb = form.get("thumb");
    const rawMetadata = form.get("metadata");

    if (!(image instanceof File)) {
      throw new HTTPException(400, { message: "image part is required" });
    }
    if (typeof rawMetadata !== "string") {
      throw new HTTPException(400, { message: "metadata part is required" });
    }

    // multipart の中に埋まった JSON はバリデータでは扱えないので、
    // ここで parse してから同じ zod スキーマに通す。
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawMetadata);
    } catch {
      throw new HTTPException(400, { message: "metadata is not valid JSON" });
    }
    const result = UploadPhotoMetadataSchema.safeParse(parsed);
    if (!result.success) {
      throw new HTTPException(400, { message: `invalid metadata: ${result.error.message}` });
    }
    const metadata = result.data;

    // R2 は内容アドレスなので、同じ写真を再送しても同じキーを上書きするだけ。
    const keys = photoKeys(ownerId, metadata.sourceSha256);
    await c.get("photos").put(keys.r2Key, image.stream(), {
      httpMetadata: { contentType: "image/avif" },
    });
    if (thumb instanceof File) {
      await c.get("photos").put(keys.thumbKey, thumb.stream(), {
        httpMetadata: { contentType: "image/avif" },
      });
    }

    // R2 を先に書いてから D1 に入れる。逆順だと行はあるのに実体が無い状態が起きうる。
    const inserted = await insertPhoto(c.get("db"), ownerId, metadata, image.size);
    const body: UploadPhotoResponse = inserted;
    return c.json(body, inserted.deduplicated ? 200 : 201);
  },
);

photosRouter.post(
  "/users/:id/photos/check",
  describeRoute({
    tags: ["photos"],
    summary: "送信済みハッシュの一括判定",
    description:
      "ヒットしたハッシュだけを返す。所有者で絞るため、他人がアップロードした写真は決して当たらない。",
    responses: {
      200: {
        description: "既にアップロード済みのハッシュ",
        content: { "application/json": { schema: resolver(CheckPhotosResponseSchema) } },
      },
      400: {
        description: "ハッシュの形式が不正、または上限を超えている",
        content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
      },
      ...commonErrorResponses,
    },
  }),
  validator("param", UserParamSchema),
  validator("json", CheckPhotosRequestSchema),
  async (c) => {
    const { hashes } = c.req.valid("json");
    const uploaded = await findUploadedHashes(c.get("db"), c.get("ownerId"), hashes);
    return c.json({ uploaded });
  },
);

photosRouter.get(
  "/users/:id/photos/:photoId",
  describeRoute({
    tags: ["photos"],
    summary: "写真 1 枚の詳細",
    responses: {
      200: {
        description: "同席者とタグを含む写真 1 枚",
        content: { "application/json": { schema: resolver(ApiPhotoSchema) } },
      },
      ...notFoundResponse,
      ...commonErrorResponses,
    },
  }),
  validator("param", UserPhotoParamSchema),
  async (c) => {
    // 所有者条件込みで引くので、他人の写真 ID を指定しても 404 になる。
    const photo = await getPhoto(
      c.get("db"),
      c.get("ownerId"),
      c.req.param("photoId"),
      c.env.BETTER_AUTH_SECRET,
    );
    if (!photo) throw new HTTPException(404, { message: "photo not found" });
    return c.json(photo);
  },
);

// `:photoId` より前に置く。パスの深さが違うので実際には食い合わないが、
// 「具体的なものを先に」の順序にしておけば、後から増やしたときも取り違えない。
photosRouter.delete(
  "/users/:id/photos/by-hash/:sourceSha256",
  describeRoute({
    tags: ["photos"],
    summary: "変換前ハッシュを指定した写真の削除",
    description:
      "消すものは ID 指定の削除とまったく同じ。行の特定に (owner_id, source_sha256) を使う。" +
      "デスクトップはサーバー側の写真 ID を覚えていないので、手元で計算できる" +
      "変換前 PNG の SHA-256 から消せるようにしてある。" +
      "他人の写真のハッシュを指定した場合も 404（存在の有無は返さない）。",
    responses: {
      204: { description: "削除した" },
      400: {
        description: "ハッシュの形式が不正",
        content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
      },
      ...notFoundResponse,
      ...commonErrorResponses,
    },
  }),
  validator("param", UserPhotoHashParamSchema),
  async (c) => {
    const keys = await deletePhotoBySourceHash(
      c.get("db"),
      c.get("ownerId"),
      c.req.param("sourceSha256"),
    );
    if (!keys) throw new HTTPException(404, { message: "photo not found" });
    // ID 指定のときと同じく、R2 の削除は応答をブロックしない。
    waitUntil(
      c.get("photos").delete(keys.thumbKey ? [keys.r2Key, keys.thumbKey] : [keys.r2Key]),
    );
    return c.body(null, 204);
  },
);

photosRouter.delete(
  "/users/:id/photos/:photoId",
  describeRoute({
    tags: ["photos"],
    summary: "写真の削除",
    description: "D1 の行を消してから R2 の実体を消す。失敗しても孤立するのは R2 側だけに留める。",
    responses: {
      204: { description: "削除した" },
      ...notFoundResponse,
      ...commonErrorResponses,
    },
  }),
  validator("param", UserPhotoParamSchema),
  async (c) => {
    const keys = await deletePhoto(c.get("db"), c.get("ownerId"), c.req.param("photoId"));
    if (!keys) throw new HTTPException(404, { message: "photo not found" });
    // R2 の削除は応答をブロックしない。取り残しても行は既に消えている。
    waitUntil(
      c.get("photos").delete(keys.thumbKey ? [keys.r2Key, keys.thumbKey] : [keys.r2Key]),
    );
    return c.body(null, 204);
  },
);

photosRouter.post(
  "/users/:id/photos/:photoId/rotate",
  describeRoute({
    tags: ["photos"],
    summary: "写真の回転",
    description:
      "R2 上の実体（本体とサムネイル）を指定した角度だけ時計回りに回転し、その場で上書きする。" +
      "DB に回転角は持たず、width / height / byteSize を実体に合わせて更新する。" +
      "AVIF は無損失回転ができないため再エンコードになり、繰り返すと画質は少しずつ落ちる。" +
      "BlurHash は無効になるので消し、ブラウザが後から計算し直す。" +
      "応答は更新後の写真（署名 URL も新しくなる）。",
    responses: {
      200: {
        description: "回転を反映した写真",
        content: { "application/json": { schema: resolver(ApiPhotoSchema) } },
      },
      400: {
        description: "回転角が 90 / 180 / 270 以外",
        content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
      },
      ...notFoundResponse,
      ...commonErrorResponses,
    },
  }),
  validator("param", UserPhotoParamSchema),
  validator("json", RotatePhotoRequestSchema),
  async (c) => {
    const ownerId = c.get("ownerId");
    const photoId = c.req.param("photoId");
    const { degrees } = c.req.valid("json");

    // 所有者条件込みで引くので、他人の写真 ID は 404 になる。
    const keys = await findPhotoKeys(c.get("db"), ownerId, photoId);
    if (!keys) throw new HTTPException(404, { message: "photo not found" });

    const bucket = c.get("photos");
    const object = await bucket.get(keys.r2Key);
    if (!object) throw new HTTPException(404, { message: "object not found" });

    // wasm を含むモジュールは Node の vitest から静的に辿れると壊れるので遅延で読む。
    const { rotateAvif } = await import("../server/avif");

    // 先に本体・サムネイルの両方を回転し切ってから書き込む。
    // 片方だけ上書きした状態で失敗すると、向きの食い違いが残ってしまうため。
    const image = await rotateAvif(await object.arrayBuffer(), degrees);
    let thumb: Awaited<ReturnType<typeof rotateAvif>> | null = null;
    if (keys.thumbKey) {
      const thumbObject = await bucket.get(keys.thumbKey);
      if (thumbObject) thumb = await rotateAvif(await thumbObject.arrayBuffer(), degrees);
    }

    // キーは変換前 PNG の sha256 なので、回転しても同じキーへの上書きでよい
    // （identity と重複判定は変換前の画像に対するもので、回転では変わらない）。
    await bucket.put(keys.r2Key, image.bytes, {
      httpMetadata: { contentType: "image/avif" },
    });
    if (keys.thumbKey && thumb) {
      await bucket.put(keys.thumbKey, thumb.bytes, {
        httpMetadata: { contentType: "image/avif" },
      });
    }

    await applyPhotoRotation(c.get("db"), ownerId, photoId, {
      width: image.width,
      height: image.height,
      byteSize: image.bytes.byteLength,
    });

    // 更新後の行から組み立て直す。署名 URL も新しい exp で発行される。
    const photo = await getPhoto(c.get("db"), ownerId, photoId, c.env.BETTER_AUTH_SECRET);
    if (!photo) throw new HTTPException(404, { message: "photo not found" });
    return c.json(photo);
  },
);

photosRouter.put(
  "/users/:id/photos/:photoId/tags",
  describeRoute({
    tags: ["photos"],
    summary: "写真のタグを置き換える",
    description:
      "送られたタグの集合にまるごと差し替える。ここに無いタグはこの写真から外れる。" +
      "タグ自体（名前）はユーザーの語彙として残す。",
    responses: {
      200: {
        description: "反映後のタグ",
        content: { "application/json": { schema: resolver(PutPhotoTagsResponseSchema) } },
      },
      400: {
        description: "タグの形式が不正、または個数が上限を超えている",
        content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
      },
      ...notFoundResponse,
      ...commonErrorResponses,
    },
  }),
  validator("param", UserPhotoParamSchema),
  validator("json", PutPhotoTagsRequestSchema),
  async (c) => {
    const { tags } = c.req.valid("json");
    const updated = await setPhotoTags(
      c.get("db"),
      c.get("ownerId"),
      c.req.param("photoId"),
      tags,
    );
    // 他人の写真 ID を指された場合もここに来る。存在の有無を漏らさないため 404 で揃える。
    if (!updated) throw new HTTPException(404, { message: "photo not found" });
    return c.json({ tags: updated });
  },
);

photosRouter.get(
  "/users/:id/tags",
  describeRoute({
    tags: ["photos"],
    summary: "使ったことのあるタグの一覧",
    description: "タグ入力の補完に使う。写真から外したタグも語彙として残る。",
    responses: {
      200: {
        description: "タグ名の一覧",
        content: { "application/json": { schema: resolver(ListTagsResponseSchema) } },
      },
      ...commonErrorResponses,
    },
  }),
  validator("param", UserParamSchema),
  async (c) => {
    return c.json({ tags: await listTags(c.get("db"), c.get("ownerId")) });
  },
);

photosRouter.get(
  "/users/:id/facets",
  describeRoute({
    tags: ["photos"],
    summary: "絞り込みに使えるワールドと VRChat ユーザーの一覧",
    description:
      "ID を覚えていなくても名前で選べるようにするための選択肢。" +
      "呼び出し元自身の写真から作るので、他人の写真に出てくる名前は含まれない。" +
      "どちらも写真の多い順で、上限を超えた分は返らない。",
    responses: {
      200: {
        description: "ワールドと VRChat ユーザーの一覧",
        content: { "application/json": { schema: resolver(ListFacetsResponseSchema) } },
      },
      ...commonErrorResponses,
    },
  }),
  validator("param", UserParamSchema),
  async (c) => {
    return c.json(await listFacets(c.get("db"), c.get("ownerId")));
  },
);

export default photosRouter;
