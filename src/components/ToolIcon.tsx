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

// A quiet, monochrome tile that inks in when its row is hovered. Tools are
// told apart by glyph, not colour.
export function ToolIcon({ tool, size = 40 }: { tool: Tool; size?: number }) {
  const Icon = ICONS[tool.icon] ?? FileText;
  return (
    <span
      aria-hidden
      className="inline-grid shrink-0 place-items-center border border-line bg-surface text-ink-2 transition-[background-color,color,border-color,rotate,scale] duration-500 ease-(--ease-spring) group-hover:-rotate-6 group-hover:scale-105 group-hover:border-ink group-hover:bg-ink group-hover:text-bg"
      style={{ width: size, height: size, borderRadius: Math.round(size * 0.26) }}
    >
      <Icon size={Math.round(size * 0.46)} strokeWidth={1.5} />
    </span>
  );
}
