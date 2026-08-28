import { useEffect, useState } from "react";
import { Check, Copy, TriangleAlert } from "lucide-react";

import { Button } from "./ui/button";

export interface WorldLinkCopyButtonProps {
  /** コピーする VRChat ワールド ID。空ならボタンを表示しない。 */
  worldId: string;
  /** コピーするワールド名。 */
  worldName: string;
  /** VRCX が記録したワールド作者名。 */
  authorName?: string | null;
}

/** VRChat のワールド共有文をクリップボードへコピーするボタン。 */
export function WorldLinkCopyButton({ worldId, worldName, authorName }: WorldLinkCopyButtonProps) {
  const [status, setStatus] = useState<"idle" | "copied" | "error">("idle");

  useEffect(() => {
    if (status !== "copied") return;
    const timer = window.setTimeout(() => setStatus("idle"), 2_000);
    return () => window.clearTimeout(timer);
  }, [status]);

  if (!worldId) return null;

  const worldUrl = `https://vrchat.com/home/launch?worldId=${encodeURIComponent(worldId)}`;
  const copyText = `World: ${worldName}${authorName ? ` By ${authorName}` : ""}\n${worldUrl}`;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(copyText);
      setStatus("copied");
    } catch {
      setStatus("error");
    }
  };

  const label = status === "copied" ? "コピーしました" : status === "error" ? "コピーに失敗" : "リンクをコピー";
  const Icon = status === "copied" ? Check : status === "error" ? TriangleAlert : Copy;

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={handleCopy}
      aria-label={label}
      title={label}
    >
      <Icon aria-hidden />
      {label}
    </Button>
  );
}
