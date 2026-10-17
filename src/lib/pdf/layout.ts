"use client";

// Page structure for PDF → Word and Markdown: reading order across columns,
// figures, links, and the headers and footers that repeat on every page.
//
// Reading order is a recursive XY-cut (Nagy & Seth): split the page into
// bands at horizontal gaps, split a band into columns at vertical gaps that
// run through all of it, and recurse. Bands whose columns line up are joined
// first, so a gap that happens to line up across two columns doesn't cut them.

import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import { groupLines, pageText, type Line, type Run } from "./text";
import { bandCells, buildTables, findTables, pageEdges, pieces, type Layout, type Rect, type Table } from "./tables";

export type Figure = Rect;
export type Item = { kind: "lines"; lines: Line[] } | { kind: "table"; table: Table } | { kind: "figure"; figure: Figure };
export type Column = { x0: number; x1: number; items: Item[] };
// One band of the page: a single column, or several read left to right.
export type Section = { y0: number; y1: number; columns: Column[] };
export type PageLayout = Layout & {
  figures: Figure[];
  sections: Section[];
  // Lines repeated on most pages; Word puts them in the page header and footer.
  header: Line[];
  footer: Line[];
  // Box around the body text, for page margins.
  content: Rect | null;
};

type Box = Rect & ({ kind: "word"; run: Run } | { kind: "table"; table: Table } | { kind: "figure"; figure: Figure });

// ── Words

// Splits runs into words so a column gap inside a run can still be found.
function words(runs: Run[]): Run[] {
  const out: Run[] = [];
  for (const r of runs) {
    const n = r.text.length;
    const xs = r.xs && r.xs.length === n + 1 ? r.xs : Array.from({ length: n + 1 }, (_, k) => r.x + (r.w * k) / n);
    let s = -1;
    for (let k = 0; k <= n; k++) {
      const space = k === n || r.text[k] === " ";
      if (!space && s < 0) s = k;
      if (space && s >= 0) {
        out.push({ ...r, text: r.text.slice(s, k), x: xs[s], w: xs[k] - xs[s], xs: xs.slice(s, k + 1) });
        s = -1;
      }
    }
  }
  return out;
}

const wordBox = (run: Run): Box => ({ kind: "word", run, x0: run.x, x1: run.x + run.w, y0: run.y, y1: run.y + run.h });

// ── XY-cut

// Rows of boxes separated by any horizontal gap.
function bands(boxes: Box[]): Box[][] {
  const sorted = [...boxes].sort((a, b) => a.y0 - b.y0);
  const out: Box[][] = [];
  let bottom = -Infinity;
  for (const b of sorted) {
    if (!out.length || b.y0 > bottom) {
      out.push([b]);
      bottom = b.y1;
    } else {
      out[out.length - 1].push(b);
      bottom = Math.max(bottom, b.y1);
    }
  }
  return out;
}

// Vertical gaps no box crosses, at least `min` wide, inside the boxes' extent.
function gutters(boxes: Box[], min: number): [number, number][] {
  const spans = boxes.map((b) => [b.x0, b.x1]).sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  let end = spans[0]?.[1] ?? 0;
  for (const [a, b] of spans.slice(1)) {
    if (a - end >= min) out.push([end, a]);
    end = Math.max(end, b);
  }
  return out;
}

// Same number of gaps, each overlapping its partner: the same columns.
const sameGutters = (a: [number, number][], b: [number, number][]) =>
  a.length > 0 && a.length === b.length && a.every(([s, e], i) => s < b[i][1] && e > b[i][0]);

const rowsOf = (boxes: Box[]) => groupLines(boxes.filter((b) => b.kind === "word").map((b) => (b as { run: Run }).run));

function splitColumns(boxes: Box[], gs: [number, number][]): Box[][] {
  const cuts = gs.map(([a, b]) => (a + b) / 2);
  const cols: Box[][] = [...cuts.map(() => []), []];
  for (const b of boxes) {
    const cx = (b.x0 + b.x1) / 2;
    let k = 0;
    while (k < cuts.length && cx > cuts[k]) k++;
    cols[k].push(b);
  }
  return cols.filter((c) => c.length);
}

// Prose columns have long lines; side-by-side short entries are a borderless table.
function classify(boxes: Box[], gs: [number, number][]): "single" | "columns" | "table" {
  if (!gs.length) return "single";
  const cols = splitColumns(boxes, gs);
  const prose = cols.length <= 4 && cols.every((c) => {
    if (c.some((b) => b.kind !== "word")) return true; // holds a table or figure
    const lines = rowsOf(c);
    return lines.length >= 2 && lines.reduce((s, l) => s + l.text.length, 0) / lines.length >= 18;
  });
  if (prose) return "columns";
  return boxes.every((b) => b.kind === "word") && rowsOf(boxes).length >= 3 ? "table" : "single";
}

function itemsOf(boxes: Box[]): Item[] {
  const runs = boxes.filter((b) => b.kind === "word").map((b) => (b as { run: Run }).run);
  const lines = groupLines(runs);
  const blocks: { y: number; item: Item }[] = [];
  for (const b of boxes) {
    if (b.kind === "table") blocks.push({ y: b.y0, item: { kind: "table", table: b.table } });
    else if (b.kind === "figure") blocks.push({ y: b.y0, item: { kind: "figure", figure: b.figure } });
  }
  blocks.sort((a, b) => a.y - b.y);
  const out: Item[] = [];
  let li = 0;
  const pushLines = (until: number) => {
    const chunk: Line[] = [];
    while (li < lines.length && lines[li].y < until) chunk.push(lines[li++]);
    if (chunk.length) out.push({ kind: "lines", lines: chunk });
  };
  for (const b of blocks) {
    pushLines(b.y);
    out.push(b.item);
  }
  pushLines(Infinity);
  return out;
}

const extent = (boxes: Box[]): Rect => ({
  x0: Math.min(...boxes.map((b) => b.x0)), x1: Math.max(...boxes.map((b) => b.x1)),
  y0: Math.min(...boxes.map((b) => b.y0)), y1: Math.max(...boxes.map((b) => b.y1)),
});

function xyCut(boxes: Box[], size: number, depth = 0): Section[] {
  if (!boxes.length) return [];
  const minGutter = Math.max(size * 0.9, 7);

  // Grow groups of rows while a column gap still runs through all of them.
  // A row with text in only one column (a paragraph break in the other) still fits.
  const joined: { boxes: Box[]; gs: [number, number][] }[] = [];
  for (const row of bands(boxes)) {
    const last = joined[joined.length - 1];
    if (last && last.gs.length) {
      const union = [...last.boxes, ...row];
      const gs = gutters(union, minGutter);
      if (sameGutters(gs, last.gs)) {
        last.boxes = union;
        last.gs = gs;
        continue;
      }
    }
    const gs = gutters(row, minGutter);
    if (last && !last.gs.length && !gs.length) last.boxes.push(...row);
    else joined.push({ boxes: [...row], gs });
  }

  const out: Section[] = [];
  for (const part of joined) {
    const kind = classify(part.boxes, part.gs);
    const ext = extent(part.boxes);
    if (kind === "columns") {
      const cols = splitColumns(part.boxes, part.gs).filter((c) => c.length);
      out.push({
        y0: ext.y0, y1: ext.y1,
        columns: cols.map((c) => {
          const e = extent(c);
          // A column can have its own structure; flatten it into reading order.
          const inner = depth < 3 ? xyCut(c, size, depth + 1) : [{ y0: e.y0, y1: e.y1, columns: [{ x0: e.x0, x1: e.x1, items: itemsOf(c) }] }];
          return { x0: e.x0, x1: e.x1, items: inner.flatMap((s) => s.columns.flatMap((col) => col.items)) };
        }),
      });
    } else if (kind === "table") {
      const runs = part.boxes.filter((b) => b.kind === "word").map((b) => (b as { run: Run }).run);
      const rects = bandCells({ ...ext, x0: ext.x0 - 1, x1: ext.x1 + 1, y0: ext.y0 - 1, y1: ext.y1 + 1 }, runs);
      const built = rects ? buildTables([{ rects, ruled: false }], runs) : null;
      const others = part.boxes.filter((b) => b.kind !== "word");
      const tableBoxes: Box[] = built ? built.tables.map((t) => ({ kind: "table", table: t, x0: t.x, y0: t.y, x1: t.x + t.w, y1: t.y + t.h })) : [];
      const left = built ? built.rest.map(wordBox) : part.boxes.filter((b) => b.kind === "word");
      out.push({ y0: ext.y0, y1: ext.y1, columns: [{ x0: ext.x0, x1: ext.x1, items: itemsOf([...left, ...others, ...tableBoxes]) }] });
    } else {
      out.push({ y0: ext.y0, y1: ext.y1, columns: [{ x0: ext.x0, x1: ext.x1, items: itemsOf(part.boxes) }] });
    }
  }

  // Neighbouring single-column sections read as one.
  const merged: Section[] = [];
  for (const s of out) {
    const last = merged[merged.length - 1];
    if (last && last.columns.length === 1 && s.columns.length === 1) {
      last.y1 = s.y1;
      last.columns[0].x0 = Math.min(last.columns[0].x0, s.columns[0].x0);
      last.columns[0].x1 = Math.max(last.columns[0].x1, s.columns[0].x1);
      last.columns[0].items.push(...s.columns[0].items);
    } else merged.push(s);
  }
  return merged;
}

// ── Page parts

async function pageLinks(page: PDFPageProxy): Promise<{ rect: Rect; url: string }[]> {
  const viewport = page.getViewport({ scale: 1 });
  const annots = (await page.getAnnotations()) as { subtype?: string; url?: string; unsafeUrl?: string; rect?: number[] }[];
  return annots
    .filter((a) => a.subtype === "Link" && (a.url || a.unsafeUrl) && a.rect)
    .map((a) => {
      const [x0, y0] = viewport.convertToViewportPoint(a.rect![0], a.rect![1]);
      const [x1, y1] = viewport.convertToViewportPoint(a.rect![2], a.rect![3]);
      return { rect: { x0: Math.min(x0, x1), x1: Math.max(x0, x1), y0: Math.min(y0, y1), y1: Math.max(y0, y1) }, url: (a.url || a.unsafeUrl)! };
    })
    .filter((l) => /^(https?|mailto):/i.test(l.url));
}

function withLinks(runs: Run[], links: { rect: Rect; url: string }[]): Run[] {
  if (!links.length) return runs;
  const inside = (x: number, y: number) => links.findIndex(({ rect: r }) => x >= r.x0 - 1 && x <= r.x1 + 1 && y >= r.y0 - 1 && y <= r.y1 + 1);
  return runs.flatMap((run) => pieces(run, inside).map((p) => (p.owner < 0 ? p.run : { ...p.run, link: links[p.owner].url })));
}

// Images worth keeping: not tiny, not page backgrounds, overlaps merged.
function figuresOf(images: Rect[], width: number, height: number): Figure[] {
  const big = images.filter((r) => r.x1 - r.x0 >= 16 && r.y1 - r.y0 >= 16 && (r.x1 - r.x0) * (r.y1 - r.y0) < width * height * 0.6);
  const out: Figure[] = [];
  for (const r of big.sort((a, b) => a.y0 - b.y0)) {
    const hit = out.find((o) => r.x0 <= o.x1 + 2 && r.x1 >= o.x0 - 2 && r.y0 <= o.y1 + 2 && r.y1 >= o.y0 - 2);
    if (hit) Object.assign(hit, { x0: Math.min(hit.x0, r.x0), y0: Math.min(hit.y0, r.y0), x1: Math.max(hit.x1, r.x1), y1: Math.max(hit.y1, r.y1) });
    else out.push({ ...r, x0: Math.max(0, r.x0), y0: Math.max(0, r.y0), x1: Math.min(width, r.x1), y1: Math.min(height, r.y1) });
  }
  return out;
}

const keyOf = (text: string) => text.replace(/\d+/g, "#").replace(/\s+/g, " ").trim().toLowerCase();

// Running headers and footers sit near the edge and are no bigger than body text.
function isFurniture(l: Line, height: number, body: number) {
  return (l.y < height * 0.12 || l.y + l.size > height * 0.88) && l.size <= body * 1.15;
}

function bodySize(runs: Run[]) {
  const counts = new Map<number, number>();
  for (const r of runs) counts.set(Math.round(r.size), (counts.get(Math.round(r.size)) ?? 0) + r.text.length);
  let best = 10;
  let max = 0;
  for (const [s, n] of counts) if (n > max) [best, max] = [s, n];
  return best;
}

function finish(base: Layout, figures: Figure[], furniture: Set<string>, body: number): PageLayout {
  const header: Line[] = [];
  const footer: Line[] = [];
  const skip: Rect[] = [];
  for (const l of base.lines) {
    if (!isFurniture(l, base.height, body) || !furniture.has(keyOf(l.text))) continue;
    (l.y < base.height / 2 ? header : footer).push(l);
    skip.push({ x0: l.x - 1, x1: l.x + l.w + 1, y0: l.y - 1, y1: l.y + l.size + 1 });
  }
  const within = (r: Rect, x: number, y: number) => x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1;
  const runs = words(base.rest).filter((r) => {
    const cx = r.x + r.w / 2;
    const cy = r.y + r.h / 2;
    // Text inside a figure is part of the picture.
    return !skip.some((s) => within(s, cx, cy)) && !figures.some((f) => within(f, cx, cy));
  });
  const boxes: Box[] = [
    ...runs.map(wordBox),
    ...base.tables.map((t): Box => ({ kind: "table", table: t, x0: t.x, y0: t.y, x1: t.x + t.w, y1: t.y + t.h })),
    ...figures.map((f): Box => ({ kind: "figure", figure: f, ...f })),
  ];
  return {
    ...base, figures, header, footer,
    sections: xyCut(boxes, bodySize(runs)),
    content: boxes.length ? extent(boxes) : null,
  };
}

type Base = Layout & { images: Rect[] };

async function basePage(page: PDFPageProxy): Promise<Base> {
  const text = await pageText(page);
  try {
    const [edges, links] = await Promise.all([pageEdges(page), pageLinks(page).catch(() => [])]);
    const base = findTables({ ...text, items: withLinks(text.items, links) }, edges);
    return { ...base, images: edges.images ?? [] };
  } catch {
    return { width: text.width, height: text.height, tables: [], lines: text.lines, rest: text.items, images: [] };
  }
}

export async function documentLayout(doc: PDFDocumentProxy, onPage?: (i: number) => void): Promise<PageLayout[]> {
  const bases: Base[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    bases.push(await basePage(page));
    page.cleanup();
    onPage?.(i);
  }
  // Header and footer lines: near the top or bottom edge, same text (numbers aside) on most pages.
  const body = bodySize(bases.flatMap((b) => b.rest));
  const counts = new Map<string, number>();
  for (const b of bases) {
    const seen = new Set(b.lines.filter((l) => isFurniture(l, b.height, body)).map((l) => keyOf(l.text)));
    for (const k of seen) counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const furniture = new Set([...counts].filter(([k, n]) => k && n >= 2 && n >= bases.length * 0.5).map(([k]) => k));
  return bases.map((b) => finish(b, figuresOf(b.images, b.width, b.height), furniture, body));
}
