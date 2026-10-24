import {
  Combine, Split, FileOutput, FileMinus, LayoutGrid, ScanLine, Shrink, Wrench, ScanText, ImagePlus, FileType,
  Presentation, Sheet, Globe, Images, FileText, MonitorPlay, Table, Archive, Hash, RotateCw, ListOrdered, Stamp,
  Crop, PenLine, TextCursorInput, LockOpen, Lock, Signature, SquareSlash, GitCompare, TextQuote, ShieldCheck,
  MessagesSquare, Languages, SquareUser, Tags, Bookmark, Layers, Paperclip, ShieldX, Zap,
  Grid2x2, BookOpen, Eraser, Shuffle, Scaling, Contrast, PanelTop, AudioLines, Accessibility,
  type LucideIcon,
} from "lucide-react";
import type { Tool } from "@/lib/tools";

const ICONS: Record<string, LucideIcon> = {
  Combine, Split, FileOutput, FileMinus, LayoutGrid, ScanLine, Shrink, Wrench, ScanText, ImagePlus, FileType,
  Presentation, Sheet, Globe, Images, FileText, MonitorPlay, Table, Archive, Hash, RotateCw, ListOrdered, Stamp,
  Crop, PenLine, TextCursorInput, LockOpen, Lock, Signature, SquareSlash, GitCompare, TextQuote, ShieldCheck,
  MessagesSquare, Languages, SquareUser, Tags, Bookmark, Layers, Paperclip, ShieldX, Zap,
  Grid2x2, BookOpen, Eraser, Shuffle, Scaling, Contrast, PanelTop, AudioLines, Accessibility,
};

// A soft tile in the tool's family colour (globals.css, [data-cat]). Inside
// a `group`, it tilts and bounces a little on hover.
export function ToolIcon({ tool, size = 40 }: { tool: Tool; size?: number }) {
  const Icon = ICONS[tool.icon] ?? FileText;
  return (
    <span
      aria-hidden
      data-cat={tool.category}
      className="inline-grid shrink-0 place-items-center bg-(--tint) text-(--tint-ink) transition-[rotate,scale] duration-500 ease-(--ease-spring) group-hover:-rotate-8 group-hover:scale-110"
      style={{ width: size, height: size, borderRadius: Math.round(size * 0.32) }}
    >
      <Icon size={Math.round(size * 0.48)} strokeWidth={1.75} />
    </span>
  );
}
