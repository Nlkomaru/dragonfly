// ログイン画面。ログイン手段は Discord のみ（server/auth.ts の方針）。
//
// `?redirect=` にはログイン前にいたパスが入る。値は sanitizeRedirectTo() で
// 同一オリジンのパスに丸めてから使う。

import { Button } from "@dragonfly/ui";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { useState } from "react";
import { signInWithDiscord } from "../lib/authClient";
import { sanitizeRedirectTo } from "../lib/redirectTo";
import { fetchSessionUser } from "../server/session";

export const Route = createFileRoute("/login")({
  // 検証はここ 1 か所に集約する。beforeLoad も画面も、丸めた後の値だけを見る。
  validateSearch: (search: Record<string, unknown>): { redirect: string } => ({
    redirect: sanitizeRedirectTo(search.redirect),
  }),
  beforeLoad: async ({ search }) => {
    // ログイン済みならこの画面を見せる意味がないので戻り先へ送る。
    const user = await fetchSessionUser();
    if (user) throw redirect({ href: search.redirect });
  },
  component: LoginPage,
});

function LoginPage() {
  const { redirect: redirectTo } = Route.useSearch();
  // Discord へ遷移するまでの間、ボタンの二度押しを防ぐ。
  const [busy, setBusy] = useState(false);

  function handleSignIn() {
    setBusy(true);
    // 戻り先を決めるのは OAuth コールバック側なので、必ず callbackURL として渡す。
    // ここを省くと signInWithDiscord の既定値（/settings/keys）に固定されてしまう。
    void signInWithDiscord(redirectTo).catch(() => setBusy(false));
  }

  return (
    <main className="flex min-h-screen items-center justify-center p-8">
      <div className="flex w-full max-w-sm flex-col gap-6 rounded-lg border border-border bg-card p-8">
        <header className="flex flex-col gap-2">
          <h1 className="text-2xl font-bold">dragonfly</h1>
          <p className="text-sm text-muted-foreground">
            続けるには Discord でログインしてください。許可されたアカウントのみ利用できます。
          </p>
        </header>
        <Button type="button" disabled={busy} onClick={handleSignIn}>
          Discord でログイン
        </Button>
      </div>
    </main>
  );
}
