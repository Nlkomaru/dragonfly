// API キーの失効。行は監査のために残し、revoked_at を立てるだけ。
import { createFileRoute } from "@tanstack/react-router";
import { HttpError, withAuth } from "../../../server/auth";
import { revokeApiKey } from "../../../server/db";

export const Route = createFileRoute("/api/keys/$id")({
  server: {
    handlers: {
      DELETE: ({ request, params }) =>
        withAuth(request, async ({ db, userId }) => {
          // 自分の鍵しか失効できない。他人の鍵 ID を指定しても 404 になる。
          const revoked = await revokeApiKey(db, userId, params.id);
          if (!revoked) throw new HttpError(404, "api key not found");
          return new Response(null, { status: 204 });
        }),
    },
  },
});
