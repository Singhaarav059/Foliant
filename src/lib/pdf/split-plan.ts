// What Split PDF will make, before it runs: default ranges that fit the
// file, and the files a choice of ranges or a page count gives. The
// workspace shows them under the options; split() names its parts the same way.

import { parseRanges } from "./common";

// Pages as a label, 1-based: "4", or "2-5" for a run.
export const rangeLabel = (pages: number[]) =>
  pages.length === 1 ? `${pages[0] + 1}` : `${pages[0] + 1}-${pages[pages.length - 1] + 1}`;

// Any pages as runs: "1-3, 5".
function runs(pages: number[]) {
  const out: string[] = [];
  for (let i = 0; i < pages.length; ) {
    let j = i;
    while (j + 1 < pages.length && pages[j + 1] === pages[j] + 1) j++;
    out.push(rangeLabel(pages.slice(i, j + 1)));
    i = j + 1;
  }
  return out.join(", ");
}

// A workflow saved before sizes came in KB or MB has its limit as maxMb.
export const sizeFromMb = (o: Record<string, unknown>) =>
  o.maxMb !== undefined && o.maxSize === undefined ? { maxSize: o.maxMb, sizeUnit: "MB" } : {};

// Two halves of the file ("1-2, 3" for three pages); one page stays whole.
export function defaultRanges(total: number) {
  if (total <= 1) return "1";
  const half = Math.ceil(total / 2);
  return `${rangeLabel(Array.from({ length: half }, (_, i) => i))}, ${rangeLabel(Array.from({ length: total - half }, (_, i) => half + i))}`;
}

// The page ranges of each file a split makes, or undefined when that's only
// known once it runs (by size or by bookmarks).
export function rangesPreview(o: { splitMode?: unknown; ranges?: unknown; every?: unknown; mergeRanges?: unknown }, total: number): string[] | undefined {
  if (o.splitMode === "every") {
    const n = Math.max(1, Math.floor(Number(o.every) || 1));
    const out: string[] = [];
    for (let i = 0; i < total; i += n) {
      const last = Math.min(total, i + n) - 1;
      out.push(rangeLabel(last === i ? [i] : [i, last]));
    }
    return out;
  }
  if (o.splitMode !== "ranges" && o.splitMode !== undefined) return undefined;
  const groups = parseRanges(String(o.ranges ?? ""), total);
  if (o.mergeRanges) return groups.length ? [runs(groups.flat())] : [];
  return groups.map(rangeLabel);
}
