/**
 * 実行環境の差（Tauri の IPC / Web の HTTP）をこの層に閉じ込める。
 * 画面側は常にこのモジュール経由で呼び出し、環境分岐を書かないこと。
 */

export { assetUrl } from "./asset";

/** Tauri の WebView 上で動いているかを判定する。 */
export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/**
 * コマンドを実行する。Tauri では `invoke`、Web では同名のエンドポイントへ POST する。
 * コマンド名はスネークケースで統一し、両環境で同じ名前を使う。
 */
export async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (isTauri()) {
    // Web ビルドに @tauri-apps/api を含めないため、動的 import で遅延解決する。
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<T>(command, args);
  }

  const res = await fetch(`/api/${command}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(args ?? {}),
  });
  if (!res.ok) throw new Error(`${command} failed: ${res.status}`);
  return (await res.json()) as T;
}
