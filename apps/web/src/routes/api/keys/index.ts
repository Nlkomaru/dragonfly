// API キーの一覧と発行。
import { createFileRoute } from "@tanstack/react-router";
import { HttpError, withAuth } from "../../../server/auth";
import { createApiKey, listApiKeys } from "../../../server/db";

export const Route = createFileRoute("/api/keys/")({
  server: {
    handlers: {
      GET: ({ request }) =>
        withAuth(request, async ({ db, userId }) => Response.json(await listApiKeys(db, userId))),

      POST: ({ request }) =>
        withAuth(request, async ({ db, userId }) => {
          const body = (await request.json()) as { name?: unknown };
          const name = typeof body?.name === "string" ? body.name.trim() : "";
          if (!name) throw new HttpError(400, "name is required");
          // rawKey が応答に載るのはここだけ。以後どこにも残らない。
          return Response.json(await createApiKey(db, userId, name), { status: 201 });
        }),
    },
  },
});
