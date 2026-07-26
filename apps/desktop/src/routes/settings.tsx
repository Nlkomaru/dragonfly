import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, FolderOpen, Eye, EyeOff } from "lucide-react";
import { Button, Input, Label } from "@dragonfly/ui";
import { call } from "@dragonfly/api-client";
import { DEFAULT_SETTINGS, type AppSettings, type MeResponse } from "@dragonfly/core";

export const Route = createFileRoute("/settings")({
  component: SettingsPage,
});

/** 接続テストの結果。鍵が悪いのか到達できないのかを区別して伝える。 */
type ConnectionState =
  | { status: "idle" }
  | { status: "testing" }
  | { status: "ok"; displayName: string }
  | { status: "error"; message: string };

function SettingsPage() {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [hasApiKey, setHasApiKey] = useState(false);
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [revealKey, setRevealKey] = useState(false);
  const [connection, setConnection] = useState<ConnectionState>({ status: "idle" });

  useEffect(() => {
    void (async () => {
      setSettings(await call<AppSettings>("get_settings"));
      // 保存済みの API キーは読み戻さない。有無だけを問い合わせる。
      setHasApiKey(await call<boolean>("has_api_key"));
    })();
  }, []);

  const save = useCallback(async (next: AppSettings) => {
    setSettings(next);
    await call<void>("set_settings", { settings: next });
  }, []);

  /** OS のフォルダ選択ダイアログを開く。選び直したら Rust 側が再走査を促す。 */
  const pickDir = useCallback(async () => {
    const dir = await call<string | null>("pick_screenshot_dir");
    if (dir) await save({ ...settings, screenshotDir: dir });
  }, [settings, save]);

  const saveApiKey = useCallback(async () => {
    await call<void>("set_api_key", { key: apiKeyInput });
    setApiKeyInput("");
    setHasApiKey(true);
  }, [apiKeyInput]);

  const testConnection = useCallback(async () => {
    setConnection({ status: "testing" });
    try {
      const me = await call<MeResponse>("test_connection");
      setConnection({ status: "ok", displayName: me.displayName });
    } catch (error) {
      setConnection({ status: "error", message: String(error) });
    }
  }, []);

  return (
    <div className="mx-auto max-w-2xl space-y-8 p-8">
      <div className="flex items-center gap-2">
        <Link to="/" className="flex items-center gap-1 text-sm text-muted-foreground">
          <ArrowLeft className="size-4" />
          戻る
        </Link>
        <h1 className="text-xl font-semibold">設定</h1>
      </div>

      <section className="space-y-2">
        <Label>スクリーンショットの保存先</Label>
        <div className="flex gap-2">
          <Input
            value={settings.screenshotDir}
            placeholder="未設定（Pictures/VRChat を使用）"
            onChange={(event) => void save({ ...settings, screenshotDir: event.target.value })}
          />
          <Button variant="outline" onClick={() => void pickDir()}>
            <FolderOpen className="size-4" />
            選択
          </Button>
        </div>
      </section>

      <section className="space-y-2">
        <Label>API キー</Label>
        <p className="text-sm text-muted-foreground">
          Web の設定画面で発行した `dfly_` から始まるキーを貼り付けてください。
          キーは OS のキーチェーンに保存され、この画面には二度と表示されません。
        </p>
        <div className="flex gap-2">
          <Input
            type={revealKey ? "text" : "password"}
            value={apiKeyInput}
            placeholder={hasApiKey ? "保存済み（上書きするには入力）" : "dfly_..."}
            onChange={(event) => setApiKeyInput(event.target.value)}
          />
          <Button variant="ghost" size="icon" onClick={() => setRevealKey((prev) => !prev)}>
            {revealKey ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
          </Button>
          <Button onClick={() => void saveApiKey()} disabled={apiKeyInput.length === 0}>
            保存
          </Button>
        </div>
      </section>

      <section className="space-y-2">
        <Label>接続先</Label>
        <Input
          value={settings.apiBaseUrl}
          onChange={(event) => void save({ ...settings, apiBaseUrl: event.target.value })}
        />
        <div className="flex items-center gap-3">
          <Button
            variant="outline"
            onClick={() => void testConnection()}
            disabled={connection.status === "testing"}
          >
            接続テスト
          </Button>
          <ConnectionMessage state={connection} />
        </div>
      </section>

      <section className="space-y-2">
        <Label>AVIF の品質（{settings.avifQuality}）</Label>
        <Input
          type="range"
          min={20}
          max={90}
          value={settings.avifQuality}
          onChange={(event) => void save({ ...settings, avifQuality: Number(event.target.value) })}
        />
      </section>
    </div>
  );
}

function ConnectionMessage({ state }: { state: ConnectionState }) {
  switch (state.status) {
    case "ok":
      return <span className="text-sm text-green-600">接続できました（{state.displayName}）</span>;
    case "error":
      return <span className="text-sm text-destructive">{state.message}</span>;
    case "testing":
      return <span className="text-sm text-muted-foreground">確認中…</span>;
    default:
      return null;
  }
}
