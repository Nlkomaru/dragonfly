import { useState } from "react";
import { Check, Loader2, Plus, X } from "lucide-react";

import { cn } from "../lib/utils";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "./ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";

/** 1つのタグに許す最大文字数。サーバー側の検証と同じ値。 */
export const TAG_MAX_LENGTH = 32;
/** 1枚に付けられるタグの上限。サーバー側の検証と同じ値。 */
export const TAG_MAX_COUNT = 32;
/** ワンクリック追加として並べる候補の上限。多すぎる分は combobox の検索に任せる。 */
const QUICK_ADD_MAX = 8;

export interface TagEditorProps {
  /** 現在のタグ。順序は表示順そのまま。 */
  value: string[];
  /** 追加・削除の結果を渡す。保存は呼び出し側の責任。 */
  onChange: (next: string[]) => void;
  /** 選択肢に出す候補（そのユーザーが使ったことのあるタグ）。 */
  suggestions?: string[];
  /** 保存中。操作を止めて、進行中であることを示す。 */
  pending?: boolean;
  className?: string;
}

/** 前後の空白を落として正規化する。空文字は弾く。 */
function normalizeTag(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  return trimmed.slice(0, TAG_MAX_LENGTH);
}

/**
 * タグの選択と追加。shadcn の combobox（Popover + Command）に倣った形。
 *
 * 既存のタグから選ぶのが基本で、候補に無い語だけ新規に作れる。
 * 自由入力だけにすると、表記ゆれで実質同じタグが増えてしまうため。
 */
export function TagEditor({
  value,
  onChange,
  suggestions = [],
  pending = false,
  className,
}: TagEditorProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const atLimit = value.length >= TAG_MAX_COUNT;

  /** 選択中なら外し、そうでなければ足す。 */
  const toggleTag = (raw: string) => {
    const tag = normalizeTag(raw);
    if (tag === null) return;
    if (value.includes(tag)) {
      onChange(value.filter((current) => current !== tag));
      return;
    }
    if (atLimit) return;
    onChange([...value, tag]);
    // 続けて複数付けられるよう、開いたまま入力だけ空にする。
    setQuery("");
  };

  const removeTag = (tag: string) => {
    onChange(value.filter((current) => current !== tag));
  };

  // 候補と、既に付いているタグを合わせて一覧に出す（付いているものには ✓ が付く）。
  const options = [...new Set([...value, ...suggestions])].sort((a, b) => a.localeCompare(b, "ja"));
  // まだ付いていない候補は、開かずに押せるバッジとしても並べる（毎回 combobox を
  // 開いて選ぶのは手数が多いため）。あふれた分は combobox の検索から選んでもらう。
  const quickAdd = suggestions.filter((tag) => !value.includes(tag)).slice(0, QUICK_ADD_MAX);
  const normalizedQuery = normalizeTag(query);
  // 入力した語がどの候補とも一致しないときだけ「新しく作る」を出す。
  const canCreate =
    normalizedQuery !== null && !options.includes(normalizedQuery) && !atLimit;

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      {value.length > 0 ? (
        <div className="flex flex-wrap gap-1">
          {value.map((tag) => (
            <Badge key={tag} variant="secondary" className="gap-1 pr-1">
              {tag}
              <button
                type="button"
                aria-label={`${tag} を外す`}
                disabled={pending}
                onClick={() => removeTag(tag)}
                className="rounded-full p-0.5 opacity-70 hover:opacity-100 disabled:opacity-40"
              >
                <X className="size-3" aria-hidden />
              </button>
            </Badge>
          ))}
        </div>
      ) : null}

      {/* ワンクリックで付けられる候補。上限に達しているときは出しても押せないので隠す。 */}
      {quickAdd.length > 0 && !atLimit ? (
        <div className="flex flex-wrap gap-1">
          {quickAdd.map((tag) => (
            <Badge key={tag} asChild variant="outline">
              <button
                type="button"
                disabled={pending}
                onClick={() => toggleTag(tag)}
                className="cursor-pointer text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-40"
              >
                <Plus aria-hidden />
                {tag}
              </button>
            </Badge>
          ))}
        </div>
      ) : null}

      <div className="flex items-center gap-2">
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="outline"
              size="sm"
              role="combobox"
              aria-expanded={open}
              disabled={pending}
              className="justify-start font-normal text-muted-foreground"
            >
              <Plus aria-hidden />
              {atLimit ? `タグは ${TAG_MAX_COUNT} 個までです` : "タグを追加"}
            </Button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-64 p-0">
            <Command
              // 表記ゆれを拾いたいので、cmdk の既定の絞り込みをそのまま使う。
              loop
            >
              <CommandInput
                value={query}
                onValueChange={setQuery}
                placeholder="タグを検索 / 追加"
                maxLength={TAG_MAX_LENGTH}
              />
              <CommandList>
                {!canCreate ? <CommandEmpty>一致するタグがありません</CommandEmpty> : null}

                {canCreate ? (
                  <CommandGroup>
                    <CommandItem
                      // 検索語そのものを value にすると候補と衝突するので接頭辞を付ける。
                      value={`__create__${normalizedQuery}`}
                      onSelect={() => toggleTag(normalizedQuery)}
                    >
                      <Plus aria-hidden />「{normalizedQuery}」を新しく作る
                    </CommandItem>
                  </CommandGroup>
                ) : null}

                {options.length > 0 ? (
                  <CommandGroup heading="タグ">
                    {options.map((tag) => {
                      const selected = value.includes(tag);
                      return (
                        <CommandItem
                          key={tag}
                          value={tag}
                          // 上限に達したら、外す操作だけを残して追加は止める。
                          disabled={!selected && atLimit}
                          onSelect={() => toggleTag(tag)}
                        >
                          <Check
                            className={cn("size-4", selected ? "opacity-100" : "opacity-0")}
                            aria-hidden
                          />
                          {tag}
                        </CommandItem>
                      );
                    })}
                  </CommandGroup>
                ) : null}
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>

        {pending ? (
          <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" aria-hidden />
        ) : null}
      </div>
    </div>
  );
}
