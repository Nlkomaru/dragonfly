// 写真 1 枚の詳細取得と削除。
import { createFileRoute } from "@tanstack/react-router";
import { HttpError, withAuth } from "../../../../server/auth";
import { deletePhoto, getPhoto } from "../../../../server/db";

export const Route = createFileRoute("/api/photos/$id/")({
  server: {
    handlers: {
      GET: ({ request, params }) =>
        withAuth(request, async ({ db, userId }) => {
          // 所有者条件込みで引くので、他人の ID を指定しても 404 になる。
          const photo = await getPhoto(db, userId, params.id);
          if (!photo) throw new HttpError(404, "photo not found");
          return Response.json(photo);
        }),

      DELETE: ({ request, params }) =>
        withAuth(request, async ({ db, photos, userId }) => {
          const keys = await deletePhoto(db, userId, params.id);
          if (!keys) throw new HttpError(404, "photo not found");
          // 行を消してから実体を消す。失敗しても孤立するのは R2 側だけに留める。
          await photos.delete(keys.thumbKey ? [keys.r2Key, keys.thumbKey] : [keys.r2Key]);
          return new Response(null, { status: 204 });
        }),
    },
  },
});
