// API キーの発行・一覧・失効を行う設定画面。
// 生の鍵は発行直後の 1 度しか表示できないため、その旨を明示して控えを促す。
//
// データ取得を loader ではなくクライアント側で行っているのは、鍵の操作が
// better-auth のセッション Cookie を前提としており、better-auth のクライアントが
// ブラウザからの呼び出しを想定しているため。SSR の loader からだと Cookie を
// 自前で引き回す必要があり、かえって認証の経路が増えてしまう。

import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { authClient, signInWithDiscord, useSession } from "../../lib/authClient";

export const Route = createFileRoute("/settings/keys")({
  component: KeysPage,
});

/** 一覧に出す最小限の項目だけを持つ。better-auth の ApiKey から必要な分を抜き出したもの。 */
interface KeyRow {
  id: string;
  name: string | null;
  /** 先頭数文字。どの鍵かを見分けるためだけの非機密値。 */
  start: string | null;
  enabled: boolean;
  createdAt: Date | string;
  lastRequest: Date | string | null;
}

/** 日時を一覧向けの短い表記にする。未使用などの null は「—」。 */
function formatTime(value: Date | string | null): string {
  if (value === null) return "—";
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString("ja-JP");
}

function KeysPage() {
  const { data: session, isPending } = useSession();
  const [keys, setKeys] = useState<KeyRow[]>([]);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 発行直後の鍵。ページを離れる / 再読み込みすると失われる。
  const [createdKey, setCreatedKey] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const result = await authClient.apiKey.list();
    if (result.error) throw new Error(result.error.message ?? "鍵の一覧を取得できませんでした");
    setKeys((result.data ?? []) as unknown as KeyRow[]);
  }, []);

  useEffect(() => {
    // ログインしていないうちは呼ばない（401 になるだけなので）。
    if (!session) return;
    reload().catch((cause: unknown) => {
      setError(cause instanceof Error ? cause.message : "鍵の一覧を取得できませんでした");
    });
  }, [session, reload]);

  async function handleCreate(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await authClient.apiKey.create({ name: name.trim() });
      if (result.error) throw new Error(result.error.message ?? "鍵の発行に失敗しました");
      // 生の鍵が返るのはこの 1 回だけ。以後サーバーにもハッシュしか残らない。
      setCreatedKey(result.data?.key ?? null);
      setName("");
      await reload();
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
      // 行は消さずに無効化する。削除してしまうと「いつ誰が使っていた鍵か」が追えなくなる。
      const result = await authClient.apiKey.update({ keyId: id, enabled: false });
      if (result.error) throw new Error(result.error.message ?? "鍵の失効に失敗しました");
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "鍵の失効に失敗しました");
    } finally {
      setBusy(false);
    }
  }

  if (isPending) {
    return <main className="mx-auto max-w-3xl p-8 text-sm text-muted-foreground">読み込み中…</main>;
  }

  // 未ログインなら鍵は一切見せない。以前は暫定ユーザーに対して誰でも発行できてしまっていた。
  if (!session) {
    return (
      <main className="mx-auto flex max-w-3xl flex-col items-start gap-4 p-8">
        <h1 className="text-2xl font-bold">API キー</h1>
        <p className="text-sm text-muted-foreground">
          鍵を管理するには Discord でログインしてください。
        </p>
        <button
          type="button"
          className="rounded bg-primary px-4 py-2 text-sm text-primary-foreground"
          onClick={() => void signInWithDiscord()}
        >
          Discord でログイン
        </button>
      </main>
    );
  }

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-6 p-8">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-bold">API キー</h1>
        <p className="text-sm text-muted-foreground">
          デスクトップアプリからの送信に使う鍵を管理します（{session.user.name} としてログイン中）。
        </p>
      </header>

      {/* 発行直後だけ表示する生の鍵。 */}
      {createdKey && (
        <section className="flex flex-col gap-2 rounded-lg border border-primary bg-card p-4">
          <p className="text-sm font-semibold">
            この鍵はこの画面でしか確認できません。今すぐ控えてください。
          </p>
          <code className="select-all break-all rounded bg-muted px-3 py-2 font-mono text-sm">
            {createdKey}
          </code>
          <div className="flex gap-2">
            <button
              type="button"
              className="rounded border border-border px-3 py-1 text-sm"
              onClick={() => void navigator.clipboard.writeText(createdKey)}
            >
              コピー
            </button>
            <button
              type="button"
              className="rounded px-3 py-1 text-sm text-muted-foreground"
              onClick={() => setCreatedKey(null)}
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
        {keys.map((key) => (
          <li
            key={key.id}
            className={`flex items-center justify-between rounded border border-border p-3 ${
              key.enabled ? "" : "opacity-50"
            }`}
          >
            <div className="flex flex-col gap-0.5">
              <span className="text-sm font-medium">
                {key.name ?? "（名前なし）"}
                {!key.enabled && "（失効済み）"}
              </span>
              <span className="font-mono text-xs text-muted-foreground">{key.start ?? ""}…</span>
              <span className="text-xs text-muted-foreground">
                作成 {formatTime(key.createdAt)} / 最終利用 {formatTime(key.lastRequest)}
              </span>
            </div>
            {/* 失効済みの鍵は灰色にして一覧に残す（監査のため）。 */}
            {key.enabled && (
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
        ))}
        {keys.length === 0 && <li className="text-sm text-muted-foreground">まだ鍵がありません。</li>}
      </ul>
    </main>
  );
}
