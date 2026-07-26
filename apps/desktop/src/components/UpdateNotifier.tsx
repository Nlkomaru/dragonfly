import { useEffect, useState } from "react";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

/**
 * 起動時に更新の有無を確認し、あればダウンロード・インストールして再起動を促す。
 * 署名検証は updater プラグインが tauri.conf.json の pubkey を使って行うため、
 * フロントエンド側で追加の検証は不要。
 */
export function UpdateNotifier() {
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    // 起動直後のネットワーク失敗でアプリが落ちないよう、例外は握って表示だけに留める。
    void (async () => {
      try {
        const update = await check();
        if (!update) return;

        setStatus(`v${update.version} を取得中…`);
        await update.downloadAndInstall();
        setStatus("更新を適用しました。再起動します。");
        await relaunch();
      } catch (e) {
        setStatus(`更新の確認に失敗しました: ${String(e)}`);
      }
    })();
  }, []);

  if (!status) return null;
  return (
    <div className="fixed right-4 bottom-4 rounded-md border px-3 py-2 text-sm">
      {status}
    </div>
  );
}
