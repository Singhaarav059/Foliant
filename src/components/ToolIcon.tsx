import {
  Combine, Split, FileOutput, FileMinus, LayoutGrid, ScanLine, Shrink, Wrench, ScanText, ImagePlus, FileType,
  Presentation, Sheet, Globe, Images, FileText, MonitorPlay, Table, Archive, Hash, RotateCw, ListOrdered, Stamp,
  Crop, PenLine, TextCursorInput, LockOpen, Lock, Signature, SquareSlash, GitCompare,
  type LucideIcon,
} from "lucide-react";
import { categoryColor, type Tool } from "@/lib/tools";

const ICONS: Record<string, LucideIcon> = {
  Combine, Split, FileOutput, FileMinus, LayoutGrid, ScanLine, Shrink, Wrench, ScanText, ImagePlus, FileType,
  Presentation, Sheet, Globe, Images, FileText, MonitorPlay, Table, Archive, Hash, RotateCw, ListOrdered, Stamp,
  Crop, PenLine, TextCursorInput, LockOpen, Lock, Signature, SquareSlash, GitCompare,
};

export function ToolIcon({ tool, size = 44 }: { tool: Tool; size?: number }) {
  const Icon = ICONS[tool.icon] ?? FileText;
  const color = categoryColor(tool.category);
  return (
    <span
      aria-hidden
      className="inline-grid shrink-0 place-items-center"
      style={{
        width: size,
        height: size,
        borderRadius: size * 0.3,
        background: `color-mix(in oklab, ${color} 13%, var(--surface))`,
        color,
      }}
    >
      <Icon size={size * 0.5} strokeWidth={1.9} />
    </span>
  );
}
