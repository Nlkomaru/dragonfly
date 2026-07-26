/**
 * ローカルファイルを WebView から表示できる URL に変換する。
 * Tauri では asset プロトコルに変換し、Web では入力をそのまま URL として扱う。
 * 画面コードが `convertFileSrc` を直接呼ばずに済むよう、この層に閉じ込める。
 */
import { isTauri } from "./index";

export async function assetUrl(path: string): Promise<string> {
  if (!isTauri()) return path;
  // Web ビルドに @tauri-apps/api を含めないため、動的 import で遅延解決する。
  const { convertFileSrc } = await import("@tauri-apps/api/core");
  return convertFileSrc(path);
}
