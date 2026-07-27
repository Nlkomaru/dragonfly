/**
 * バックエンドからのイベント購読。
 * Tauri では `listen`、Web では購読先が無いので何もしない購読を返す。
 * 画面側が `@tauri-apps/api/event` を直接触らずに済むよう、この層に閉じ込める。
 */
import { isTauri } from "./index";

/** 購読を解除する関数。await 前に解除されても取りこぼさないよう、同期で返す。 */
export type Unsubscribe = () => void;

export function subscribe<T>(event: string, handler: (payload: T) => void): Unsubscribe {
  if (!isTauri()) return () => {};

  // listen の解決は非同期なので、解決前に解除された場合に備えてフラグを持つ。
  let cancelled = false;
  let unlisten: (() => void) | undefined;

  void (async () => {
    // Web ビルドに @tauri-apps/api を含めないため、動的 import で遅延解決する。
    const { listen } = await import("@tauri-apps/api/event");
    const stop = await listen<T>(event, (e) => handler(e.payload));
    if (cancelled) stop();
    else unlisten = stop;
  })();

  return () => {
    cancelled = true;
    unlisten?.();
  };
}
