// List operations behind the page board (src/components/workspace/PageBoard.tsx).
// Pure, so tests/pageboard.mjs runs them in Node as they are.

type Page = { key: string; file: number; page: number; blank?: boolean };

// The keys from the earlier click to this one, either way round. Without an
// earlier click still in the list, just this one.
export function rangeKeys(keys: string[], anchor: string | undefined, key: string): string[] {
  const from = anchor === undefined ? -1 : keys.indexOf(anchor);
  const to = keys.indexOf(key);
  if (to < 0) return [];
  if (from < 0) return [key];
  return keys.slice(Math.min(from, to), Math.max(from, to) + 1);
}

// First page of each file, then the second of each, and so on (front and back
// scans of a duplex document). Each file keeps its current order; files take
// turns in the order they first appear.
export function interleave<T extends Page>(list: T[]): T[] {
  const groups = new Map<number, T[]>();
  for (const p of list) {
    const g = groups.get(p.file);
    if (g) g.push(p);
    else groups.set(p.file, [p]);
  }
  const out: T[] = [];
  const longest = Math.max(0, ...[...groups.values()].map((g) => g.length));
  for (let i = 0; i < longest; i++) for (const g of groups.values()) if (i < g.length) out.push(g[i]);
  return out;
}

export const reverse = <T>(list: T[]): T[] => [...list].reverse();

// File order, then page order. The sort is stable, so a blank page stays
// after the page it was inserted from, and a copy after its original.
export const sortByOriginal = <T extends Page>(list: T[]): T[] => [...list].sort((x, y) => x.file - y.file || x.page - y.page);

// One plan per file, each pointing at that file alone (file 0), in board order.
export function byFile<T extends Page>(list: T[], files: number): T[][] {
  return Array.from({ length: files }, (_, fi) => list.filter((p) => p.file === fi).map((p) => ({ ...p, file: 0 })));
}

// Keys of the pages that are portrait (taller than wide) or landscape, by
// their size in the file with its own rotation applied. Square pages are neither.
export function byOrientation(list: Page[], sizes: { w: number; h: number }[][], want: "portrait" | "landscape"): string[] {
  return list
    .filter((p) => {
      const s = sizes[p.file]?.[p.page];
      return !!s && s.w !== s.h && (s.h > s.w) === (want === "portrait");
    })
    .map((p) => p.key);
}
