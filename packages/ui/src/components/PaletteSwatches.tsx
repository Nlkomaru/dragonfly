import { cn } from "../lib/utils";

export interface PaletteSwatchesProps {
  /** 代表色。ratio は画像に占める割合で、合計 1 を想定している。 */
  swatches: Array<{ hex: string; ratio: number }>;
  className?: string;
}

/**
 * 写真の代表色を、割合に比例した幅の帯として横に並べる。
 *
 * 数値やラベルを出すと一覧の情報量が増えすぎるため、見た目は色だけに絞り、
 * hex は title 属性（hover のツールチップ）に逃がしている。
 */
export function PaletteSwatches({ swatches, className }: PaletteSwatchesProps) {
  // extractPalette は常に PALETTE_SIZE 件返し、代表色が足りない分は ratio: 0 で埋まる。
  // 幅 0 の帯は描いても意味がないので落とす。
  const visible = swatches.filter((swatch) => swatch.ratio > 0);

  return (
    <div
      className={cn("flex h-3 w-full overflow-hidden rounded-full border bg-muted", className)}
      aria-hidden
    >
      {/* 全部 ratio: 0（有効画素が無かった写真）のときは空になり、
          高さだけの潰れた枠に見えてしまうので bg-muted の素の帯をそのまま見せる。 */}
      {visible.map((swatch, index) => (
        <div
          // 同じ色が複数出ることがあるので、hex だけでは key が重複しうる。
          key={`${swatch.hex}-${index}`}
          // flex-grow に ratio をそのまま渡し、帯全体を必ず埋める。
          // basis を 0 にしておかないと中身の無い div の幅がベースに乗ってしまう。
          className="h-full"
          style={{ flexGrow: swatch.ratio, flexBasis: 0, backgroundColor: swatch.hex }}
          title={swatch.hex}
        />
      ))}
    </div>
  );
}
