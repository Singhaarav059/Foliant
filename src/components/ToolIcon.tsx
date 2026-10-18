import {
  Combine, Split, FileOutput, FileMinus, LayoutGrid, ScanLine, Shrink, Wrench, ScanText, ImagePlus, FileType,
  Presentation, Sheet, Globe, Images, FileText, MonitorPlay, Table, Archive, Hash, RotateCw, ListOrdered, Stamp,
  Crop, PenLine, TextCursorInput, LockOpen, Lock, Signature, SquareSlash, GitCompare, TextQuote, ShieldCheck,
  type LucideIcon,
} from "lucide-react";
import type { Tool } from "@/lib/tools";

const ICONS: Record<string, LucideIcon> = {
  Combine, Split, FileOutput, FileMinus, LayoutGrid, ScanLine, Shrink, Wrench, ScanText, ImagePlus, FileType,
  Presentation, Sheet, Globe, Images, FileText, MonitorPlay, Table, Archive, Hash, RotateCw, ListOrdered, Stamp,
  Crop, PenLine, TextCursorInput, LockOpen, Lock, Signature, SquareSlash, GitCompare, TextQuote, ShieldCheck,
};

// A quiet, monochrome tile. Tools are told apart by glyph, not colour.
export function ToolIcon({ tool, size = 40 }: { tool: Tool; size?: number }) {
  const Icon = ICONS[tool.icon] ?? FileText;
  return (
    <span
      aria-hidden
      className="inline-grid shrink-0 place-items-center border border-line bg-surface text-ink-2 transition-colors group-hover:border-line-strong group-hover:text-ink"
      style={{ width: size, height: size, borderRadius: Math.round(size * 0.26) }}
    >
      <Icon size={Math.round(size * 0.46)} strokeWidth={1.5} />
    </span>
  );
}
