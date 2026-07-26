import type * as React from "react";
import { Toaster as Sonner, type ToasterProps } from "sonner";

/**
 * トースト表示。shadcn の既定実装は next-themes に依存するが、
 * このリポジトリでは Next.js を使わないため `theme` を props で受け取る形にした。
 * アプリ側でテーマを持っている場合はそれを渡すこと。
 */
function Toaster({ theme = "system", ...props }: ToasterProps) {
  return (
    <Sonner
      theme={theme}
      className="toaster group"
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
        } as React.CSSProperties
      }
      {...props}
    />
  );
}

export { Toaster };
export { toast } from "sonner";
