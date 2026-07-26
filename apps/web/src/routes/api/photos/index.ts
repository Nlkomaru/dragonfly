// 写真のアップロード (POST) と一覧 (GET)。
import { createFileRoute } from "@tanstack/react-router";
import type { UploadPhotoMetadata, UploadPhotoResponse } from "@dragonfly/core";
import { HttpError, withAuth } from "../../../server/auth";
import { insertPhoto, listPhotos, photoKeys } from "../../../server/db";

/** multipart の metadata パートを検証する。信用できない入力なので必須項目を明示的に見る。 */
function parseMetadata(raw: string): UploadPhotoMetadata {
  let value: UploadPhotoMetadata;
  try {
    value = JSON.parse(raw) as UploadPhotoMetadata;
  } catch {
    throw new HttpError(400, "metadata is not valid JSON");
  }
  if (typeof value.sourceSha256 !== "string" || !/^[0-9a-f]{64}$/.test(value.sourceSha256)) {
    throw new HttpError(400, "sourceSha256 must be a hex sha-256");
  }
  if (typeof value.takenAt !== "number" || typeof value.width !== "number" || typeof value.height !== "number") {
    throw new HttpError(400, "takenAt / width / height are required");
  }
  // ワールドと同席者が無い写真は検索できないため受け付けない。
  if (!value.vrcx?.world?.id || !value.vrcx?.author?.id || !Array.isArray(value.vrcx.players)) {
    throw new HttpError(400, "vrcx metadata is required");
  }
  return value;
}

/** 数値のクエリパラメータ。壊れた値は無視する（フィルタ無しとして扱う）。 */
function numberParam(params: URLSearchParams, key: string): number | undefined {
  const raw = params.get(key);
  if (raw === null) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

export const Route = createFileRoute("/api/photos/")({
  server: {
    handlers: {
      GET: ({ request }) =>
        withAuth(request, async ({ db, userId }) => {
          const params = new URL(request.url).searchParams;
          const result = await listPhotos(db, userId, {
            worldId: params.get("world") ?? undefined,
            playerId: params.get("player") ?? undefined,
            tag: params.get("tag") ?? undefined,
            from: numberParam(params, "from"),
            to: numberParam(params, "to"),
            cursor: params.get("cursor") ?? undefined,
          });
          return Response.json(result);
        }),

      POST: ({ request }) =>
        withAuth(request, async ({ db, photos, userId }) => {
          const form = await request.formData();
          const image = form.get("image");
          const thumb = form.get("thumb");
          const rawMetadata = form.get("metadata");
          if (!(image instanceof File)) throw new HttpError(400, "image part is required");
          if (typeof rawMetadata !== "string") throw new HttpError(400, "metadata part is required");
          const metadata = parseMetadata(rawMetadata);

          // R2 は内容アドレスなので、同じ写真を再送しても同じキーを上書きするだけ。
          const keys = photoKeys(userId, metadata.sourceSha256);
          await photos.put(keys.r2Key, image.stream(), {
            httpMetadata: { contentType: "image/avif" },
          });
          if (thumb instanceof File) {
            await photos.put(keys.thumbKey, thumb.stream(), {
              httpMetadata: { contentType: "image/avif" },
            });
          }

          // R2 を先に書いてから D1 に入れる。逆順だと行はあるのに実体が無い状態が起きうる。
          const result = await insertPhoto(db, userId, metadata, image.size);
          const response: UploadPhotoResponse = result;
          return Response.json(response, { status: result.deduplicated ? 200 : 201 });
        }),
    },
  },
});
