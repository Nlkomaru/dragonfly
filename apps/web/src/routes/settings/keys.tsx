// API キーの発行・一覧・失効を行う設定画面。
// 生の鍵は発行直後の 1 度しか表示できないため、その旨を明示して控えを促す。
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import type { CreateApiKeyResponse } from "@dragonfly/core";
import { fetchApiKeys, issueApiKey, revokeApiKeyAction } from "../../server/keyActions";

export const Route = createFileRoute("/settings/keys")({
  // データ取得は loader に寄せる（コンポーネント内の useEffect では取らない）。
  loader: () => fetchApiKeys(),
  component: KeysPage,
});

/** unix ミリ秒を一覧向けの短い表記にする。未使用などの null は「—」。 */
function formatTime(value: number | null): string {
  if (value === null) return "—";
  return new Date(value).toLocaleString("ja-JP");
}

function KeysPage() {
  const keys = Route.useLoaderData();
  const router = useRouter();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 発行直後の鍵。ページを離れる / 再読み込みすると失われる。
  const [created, setCreated] = useState<CreateApiKeyResponse | null>(null);

  async function handleCreate(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await issueApiKey({ data: { name } });
      setCreated(result);
      setName("");
      await router.invalidate();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "鍵の発行に失敗しました");
    } finally {
      setBusy(false);
    }
  }

  async function handleRevoke(id: string) {
    setBusy(true);
    setError(null);
    try {
      await revokeApiKeyAction({ data: { id } });
      await router.invalidate();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "鍵の失効に失敗しました");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-6 p-8">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-bold">API キー</h1>
        <p className="text-sm text-muted-foreground">
          デスクトップアプリからの送信に使う鍵を管理します。
        </p>
      </header>

      {/* 発行直後だけ表示する生の鍵。 */}
      {created && (
        <section className="flex flex-col gap-2 rounded-lg border border-primary bg-card p-4">
          <p className="text-sm font-semibold">
            この鍵はこの画面でしか確認できません。今すぐ控えてください。
          </p>
          <code className="select-all break-all rounded bg-muted px-3 py-2 font-mono text-sm">
            {created.rawKey}
          </code>
          <div className="flex gap-2">
            <button
              type="button"
              className="rounded border border-border px-3 py-1 text-sm"
              onClick={() => void navigator.clipboard.writeText(created.rawKey)}
            >
              コピー
            </button>
            <button
              type="button"
              className="rounded px-3 py-1 text-sm text-muted-foreground"
              onClick={() => setCreated(null)}
            >
              閉じる
            </button>
          </div>
        </section>
      )}

      <form onSubmit={handleCreate} className="flex gap-2">
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="鍵の名前（例: desktop）"
          className="flex-1 rounded border border-border bg-background px-3 py-2 text-sm"
        />
        <button
          type="submit"
          disabled={busy || name.trim() === ""}
          className="rounded bg-primary px-4 py-2 text-sm text-primary-foreground disabled:opacity-50"
        >
          発行
        </button>
      </form>

      {error && <p className="text-sm text-destructive">{error}</p>}

      <ul className="flex flex-col gap-2">
        {keys.map((key) => {
          // 失効済みは削除せず、灰色にして一覧に残す（監査のため）。
          const revoked = key.revokedAt !== null;
          return (
            <li
              key={key.id}
              className={`flex items-center justify-between rounded border border-border p-3 ${
                revoked ? "opacity-50" : ""
              }`}
            >
              <div className="flex flex-col gap-0.5">
                <span className="text-sm font-medium">
                  {key.name}
                  {revoked && "（失効済み）"}
                </span>
                <span className="font-mono text-xs text-muted-foreground">{key.prefix}…</span>
                <span className="text-xs text-muted-foreground">
                  作成 {formatTime(key.createdAt)} / 最終利用 {formatTime(key.lastUsedAt)}
                </span>
              </div>
              {!revoked && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void handleRevoke(key.id)}
                  className="rounded border border-border px-3 py-1 text-sm text-destructive disabled:opacity-50"
                >
                  失効
                </button>
              )}
            </li>
          );
        })}
        {keys.length === 0 && (
          <li className="text-sm text-muted-foreground">まだ鍵がありません。</li>
        )}
      </ul>
    </main>
  );
}
