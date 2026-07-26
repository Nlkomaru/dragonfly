// ローカルパスを WebView から読める URL に変換して保持する。
// 変換は非同期なので、表示に必要な分だけ先に解決してマップに貯める。

import { useEffect, useState } from "react";
import { assetUrl } from "@dragonfly/api-client";

export function useThumbnails(paths: string[]): (path: string) => string | undefined {
  const [urls, setUrls] = useState<ReadonlyMap<string, string>>(new Map());

  useEffect(() => {
    let cancelled = false;
    const missing = paths.filter((path) => !urls.has(path));
    if (missing.length === 0) return;

    void (async () => {
      const resolved = await Promise.all(
        missing.map(async (path) => [path, await assetUrl(path)] as const),
      );
      if (cancelled) return;
      setUrls((prev) => new Map([...prev, ...resolved]));
    })();

    return () => {
      cancelled = true;
    };
  }, [paths, urls]);

  return (path: string) => urls.get(path);
}
