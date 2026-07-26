import type { ComponentType, ReactNode } from "react";
import { ImageOff } from "lucide-react";

import { cn } from "../lib/utils";

export interface EmptyStateProps {
  /** lucide-react のアイコンコンポーネントを渡す。 */
  icon?: ComponentType<{ className?: string }>;
  title: string;
  description?: string;
  /** 復帰操作（再スキャンなど）を置くスロット。 */
  action?: ReactNode;
  className?: string;
}

/** データが無いときの案内。「この月には写真がありません」などに使う。 */
export function EmptyState({
  icon: Icon = ImageOff,
  title,
  description,
  action,
  className,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex h-full flex-col items-center justify-center gap-3 px-6 py-12 text-center",
        className,
      )}
    >
      <span className="flex size-12 items-center justify-center rounded-full bg-muted">
        <Icon className="size-6 text-muted-foreground" />
      </span>
      <div className="flex flex-col gap-1">
        <p className="text-sm font-medium text-foreground">{title}</p>
        {description ? (
          <p className="max-w-sm text-sm text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {action}
    </div>
  );
}
