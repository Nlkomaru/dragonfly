// 共有 UI のエントリポイント。追加したコンポーネントはここから re-export する。
export { cn } from "./lib/utils";

// shadcn プリミティブ
export { Badge, badgeVariants } from "./components/ui/badge";
export { Button, buttonVariants } from "./components/ui/button";
export { Checkbox } from "./components/ui/checkbox";
export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
} from "./components/ui/dialog";
export {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "./components/ui/command";
export { Input } from "./components/ui/input";
export { Label } from "./components/ui/label";
export {
  Popover,
  PopoverAnchor,
  PopoverContent,
  PopoverTrigger,
} from "./components/ui/popover";
export { ScrollArea, ScrollBar } from "./components/ui/scroll-area";
export { Separator } from "./components/ui/separator";
export { Toaster, toast } from "./components/ui/sonner";

// dragonfly 固有の複合コンポーネント
export { BlurhashImage, type BlurhashImageProps } from "./components/BlurhashImage";
export { EmptyState, type EmptyStateProps } from "./components/EmptyState";
export {
  FilterCombobox,
  type FilterComboboxOption,
  type FilterComboboxProps,
} from "./components/FilterCombobox";
export { MonthSidebar, type MonthSidebarProps } from "./components/MonthSidebar";
export { PaletteSwatches, type PaletteSwatchesProps } from "./components/PaletteSwatches";
export { PhotoCard, type PhotoCardProps } from "./components/PhotoCard";
export { PhotoDetailDialog, type PhotoDetailDialogProps } from "./components/PhotoDetailDialog";
export { PhotoGrid, type PhotoGridProps } from "./components/PhotoGrid";
export { PhotoLightbox, type PhotoLightboxProps } from "./components/PhotoLightbox";
export { TagEditor, type TagEditorProps } from "./components/TagEditor";
export { SelectionActionBar, type SelectionActionBarProps } from "./components/SelectionActionBar";
export { UploadProgressBar, type UploadProgressBarProps } from "./components/UploadProgressBar";
