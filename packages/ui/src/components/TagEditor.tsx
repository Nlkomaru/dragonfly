import { useId, useState, type KeyboardEvent } from "react";
import { Loader2, X } from "lucide-react";

import { cn } from "../lib/utils";
import { Badge } from "./ui/badge";
import { Input } from "./ui/input";

/** 1つのタグに許す最大文字数。サーバー側の検証と同じ値。 */
export const TAG_MAX_LENGTH = 32;
/** 1枚に付けられるタグの上限。サーバー側の検証と同じ値。 */
export const TAG_MAX_COUNT = 32;

export interface TagEditorProps {
  /** 現在のタグ。順序は表示順そのまま。 */
  value: string[];
  /** 追加・削除の結果を渡す。保存は呼び出し側の責任。 */
  onChange: (next: string[]) => void;
  /** 入力補完に出す候補（そのユーザーが使ったことのあるタグ）。 */
  suggestions?: string[];
  /** 保存中。入力を止めて、進行中であることを示す。 */
  pending?: boolean;
  className?: string;
}

/** 前後の空白を落として正規化する。空文字と長すぎる値は弾く。 */
function normalizeTag(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  return trimmed.slice(0, TAG_MAX_LENGTH);
}

/**
 * タグの追加・削除だけを行う入力。
 * Enter と カンマ で確定し、空入力での Backspace は末尾を消す
 * （タグ入力にありふれた操作なので、説明なしで通じるようにする）。
 */
export function TagEditor({
  value,
  onChange,
  suggestions = [],
  pending = false,
  className,
}: TagEditorProps) {
  const [draft, setDraft] = useState("");
  const listId = useId();

  const addDraft = () => {
    const tag = normalizeTag(draft);
    setDraft("");
    if (tag === null) return;
    // 同じタグを二重に持たせない。上限を超える追加も無視する。
    if (value.includes(tag) || value.length >= TAG_MAX_COUNT) return;
    onChange([...value, tag]);
  };

  const removeAt = (index: number) => {
    onChange(value.filter((_, i) => i !== index));
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter" || event.key === ",") {
      // Enter でダイアログのフォームが submit されないようにする。
      event.preventDefault();
      addDraft();
      return;
    }
    if (event.key === "Backspace" && draft === "" && value.length > 0) {
      removeAt(value.length - 1);
    }
  };

  // 既に付いているタグは候補から外す。
  const remaining = suggestions.filter((tag) => !value.includes(tag));

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      {value.length > 0 ? (
        <div className="flex flex-wrap gap-1">
          {value.map((tag, index) => (
            <Badge key={tag} variant="secondary" className="gap-1 pr-1">
              {tag}
              <button
                type="button"
                aria-label={`${tag} を外す`}
                disabled={pending}
                onClick={() => removeAt(index)}
                className="rounded-full p-0.5 opacity-70 hover:opacity-100 disabled:opacity-40"
              >
                <X className="size-3" aria-hidden />
              </button>
            </Badge>
          ))}
        </div>
      ) : null}

      <div className="flex items-center gap-2">
        <Input
          value={draft}
          list={listId}
          disabled={pending || value.length >= TAG_MAX_COUNT}
          maxLength={TAG_MAX_LENGTH}
          placeholder={
            value.length >= TAG_MAX_COUNT ? `タグは ${TAG_MAX_COUNT} 個までです` : "タグを追加"
          }
          aria-label="タグを追加"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={handleKeyDown}
          // 入力途中で閉じられても消えないよう、フォーカスが外れた時点で確定する。
          onBlur={addDraft}
          className="h-8 text-sm"
        />
        {pending ? (
          <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" aria-hidden />
        ) : null}
      </div>

      <datalist id={listId}>
        {remaining.map((tag) => (
          <option key={tag} value={tag} />
        ))}
      </datalist>
    </div>
  );
}
