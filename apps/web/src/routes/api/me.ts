// 接続テスト用。デスクトップの設定画面が「鍵が無効 (401)」と
// 「サーバーに届かない (通信エラー)」を区別するために使う。
import { createFileRoute } from "@tanstack/react-router";
import type { MeResponse } from "@dragonfly/core";
import { HttpError, withAuth } from "../../server/auth";
import { findUser } from "../../server/db";

export const Route = createFileRoute("/api/me")({
  server: {
    handlers: {
      GET: ({ request }) =>
        withAuth(request, async ({ db, userId }) => {
          const user = await findUser(db, userId);
          // 鍵が指すユーザーが消えている状態は認証失敗として扱う。
          if (!user) throw new HttpError(401, "invalid api key");
          const body: MeResponse = { userId: user.id, displayName: user.displayName };
          return Response.json(body);
        }),
    },
  },
});
