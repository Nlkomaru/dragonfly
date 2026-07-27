// 一覧に出すサムネイルの解決。
//
// 元のスクリーンショットは 4K・数 MB の PNG で、そのまま <img> に渡すと
// WebView が原寸をデコードして一覧がもたつく。Rust 側で縮小 JPEG を作らせ、
// そのパスを asset URL に変換して使う。
// 生成は「今見えている写真」の分だけ要求し、結果はマップに貯めて使い回す。

import { useCallback, useEffect, useRef, useState } from "react";
import { assetUrl, call } from "@dragonfly/api-client";

/** Rust の `thumbnail_paths` が返す1件分。 */
interface ThumbnailEntry {
  path: string;
  thumbnailPath: string;
}

export function useThumbnails(): {
  /** 解決済みのサムネイル URL。未生成なら undefined。 */
  thumbnailSrcFor: (path: string) => string | undefined;
  /** 表示対象が変わったときに呼ぶ。生成はここで要求した分だけ走る。 */
  requestThumbnails: (paths: string[]) => void;
} {
  const [urls, setUrls] = useState<ReadonlyMap<string, string>>(new Map());
  // 要求済みのパス。同じ写真を何度も Rust に投げないための記録で、
  // 描画には関わらないので state ではなく ref に持つ。
  const requestedRef = useRef<Set<string>>(new Set());

  // アンマウント後に setState しないためのフラグ。
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const requestThumbnails = useCallback((paths: string[]) => {
    const missing = paths.filter((path) => !requestedRef.current.has(path));
    if (missing.length === 0) return;
    for (const path of missing) requestedRef.current.add(path);

    void (async () => {
      try {
        const entries = await call<ThumbnailEntry[]>("thumbnail_paths", { paths: missing });
        const resolved = await Promise.all(
          entries.map(async (entry) => [entry.path, await assetUrl(entry.thumbnailPath)] as const),
        );
        if (!mountedRef.current) return;
        setUrls((prev) => new Map([...prev, ...resolved]));
      } catch {
        // 生成に失敗した写真はサムネイル無しで出る（カード側がプレースホルダを描く）。
        // 次にスクロールで戻ってきたときに再試行できるよう、要求済みから外す。
        for (const path of missing) requestedRef.current.delete(path);
      }
    })();
  }, []);

  const thumbnailSrcFor = useCallback((path: string) => urls.get(path), [urls]);

  return { thumbnailSrcFor, requestThumbnails };
}
