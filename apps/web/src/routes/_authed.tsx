// ログイン必須の画面をまとめるパスレスのレイアウトルート。
//
// URL には `_authed` は現れない。配下に置いたルート（`/` や `/settings/keys`）は
// すべてこの beforeLoad を通るので、保護対象を増やすときはファイルをここに移すだけでよい。
// 逆に `/login` と `/api/*` はこの配下に無いため素通しになり、リダイレクトが循環しない。

import { Link, Outlet, createFileRoute, redirect } from "@tanstack/react-router";
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
  component: AuthedLayout,
});

/**
 * 認証後の共通シェル。PhotoGrid が自身の高さを測るため、
 * h-screen から min-h-0 の連鎖をここで作る。
 */
function AuthedLayout() {
  const { user } = Route.useRouteContext();

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background text-foreground">
      <header className="flex shrink-0 items-center justify-between gap-4 border-b px-4 py-2">
        <Link to="/" className="text-sm font-semibold tracking-tight">
          dragonfly
        </Link>
        <div className="flex min-w-0 items-center gap-3 text-sm">
          {/* 表示名は長いことがあるので省略する。 */}
          <span className="truncate text-muted-foreground" title={user.name}>
            {user.name}
          </span>
          <Link
            to="/settings/keys"
            className="inline-flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
            activeProps={{ className: "bg-accent text-accent-foreground" }}
          >
            API キー
          </Link>
        </div>
      </header>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <Outlet />
      </div>
    </div>
  );
}
