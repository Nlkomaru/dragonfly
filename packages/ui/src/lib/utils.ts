import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** Tailwind のクラスを衝突なく結合する。shadcn の標準ユーティリティ。 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
