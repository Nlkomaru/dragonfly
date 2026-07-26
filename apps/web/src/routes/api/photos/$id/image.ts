// 写真本体 (AVIF) の配信。
import { createFileRoute } from "@tanstack/react-router";
import { withAuth } from "../../../../server/auth";
import { streamPhotoObject } from "../../../../server/r2";

export const Route = createFileRoute("/api/photos/$id/image")({
  server: {
    handlers: {
      GET: ({ request, params }) =>
        withAuth(request, (auth) => streamPhotoObject(auth, params.id, "image")),
    },
  },
});
