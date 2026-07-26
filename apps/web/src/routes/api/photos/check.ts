// 送信済み判定の一括問い合わせ。ヒットしたハッシュだけを返す。
import { createFileRoute } from "@tanstack/react-router";
import { CHECK_HASH_LIMIT } from "@dragonfly/core";
import type { CheckPhotosRequest, CheckPhotosResponse } from "@dragonfly/core";
import { HttpError, withAuth } from "../../../server/auth";
import { findUploadedHashes } from "../../../server/db";

export const Route = createFileRoute("/api/photos/check")({
  server: {
    handlers: {
      POST: ({ request }) =>
        withAuth(request, async ({ db, userId }) => {
          const body = (await request.json()) as CheckPhotosRequest;
          const hashes = body?.hashes;
          if (!Array.isArray(hashes)) throw new HttpError(400, "hashes must be an array");
          // 上限を超えた分はクライアント側で分割する取り決め。
          if (hashes.length > CHECK_HASH_LIMIT) {
            throw new HttpError(400, `too many hashes (max ${CHECK_HASH_LIMIT})`);
          }

          // 所有者で絞るため、他人がアップロードした写真は決してヒットしない。
          const uploaded = await findUploadedHashes(db, userId, hashes);
          const response: CheckPhotosResponse = { uploaded };
          return Response.json(response);
        }),
    },
  },
});
