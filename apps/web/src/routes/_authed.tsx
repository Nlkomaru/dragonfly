// ログイン必須の画面をまとめるパスレスのレイアウトルート。
//
// URL には `_authed` は現れない。配下に置いたルート（`/` や `/settings/keys`）は
// すべてこの beforeLoad を通るので、保護対象を増やすときはファイルをここに移すだけでよい。
// 逆に `/login` と `/api/*` はこの配下に無いため素通しになり、リダイレクトが循環しない。

import { Outlet, createFileRoute, redirect } from "@tanstack/react-router";
import { fetchSessionUser } from "../server/session";

export const Route = createFileRoute("/_authed")({
  beforeLoad: async ({ location }) => {
    // SSR 中に解決するので、未ログインなら画面を描く前にリダイレクトできる。
    const user = await fetchSessionUser();
    if (!user) {
      throw redirect({
        to: "/login",
        // 元いたパス（クエリ含む）へログイン後に戻す。
        search: { redirect: location.href },
      });
    }
    // 配下のルートから `Route.useRouteContext()` で参照できるようにしておく。
    return { user };
  },
  component: () => <Outlet />,
});
