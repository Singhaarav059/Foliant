"use client";

// Finds tables from the lines drawn on a page, the way pdfplumber does:
// collect horizontal and vertical edges, snap and join them, find where they
// cross, and take the smallest rectangles the crossings form as cells.
// Tables ruled only horizontally (rules above and below, as in most reports)
// get their columns from gaps that run through the text from top to bottom.

import type { PDFPageProxy } from "pdfjs-dist";
import { groupLines, type Line, type PageText, type Run } from "./text";

export type Edge = { x0: number; y0: number; x1: number; y1: number };
// `images` are the boxes images are painted in, and `glyphs` counts the
// characters drawn, `hidden` those drawn invisibly (an OCR text layer); the
// operator list is walked once for all of them.
export type Edges = { h: Edge[]; v: Edge[]; images?: Rect[]; glyphs?: { all: number; hidden: number } };
export type TableCell = {
  row: number; col: number; rowSpan: number; colSpan: number;
  x: number; y: number; w: number; h: number;
  text: string; bold: boolean; lines: Line[];
};
export type Table = {
  x: number; y: number; w: number; h: number;
  rows: number; cols: number; colWidths: number[]; rowHeights: number[];
  cells: TableCell[];
  ruled: boolean; // false when the columns came from the text
};
// `lines` are the lines outside tables, grouped across the whole page width;
// `rest` holds the same text as runs, for reading-order analysis. `rotation`
// is the viewport rotation the page was read in (see pageText's `upright`).
export type Layout = { width: number; height: number; tables: Table[]; lines: Line[]; rest: Run[]; rotation?: number };

const SNAP = 3; // edges this close are the same line
const JOIN = 3; // collinear edges with gaps this small are one line
const MIN_EDGE = 3;
const CROSS = 3; // how far an edge may stop short of another and still meet it

// ── Edges from the operator list

type M = [number, number, number, number, number, number];
const mul = (m: M, n: M): M => [
  m[0] * n[0] + m[1] * n[2], m[0] * n[1] + m[1] * n[3],
  m[2] * n[0] + m[3] * n[2], m[2] * n[1] + m[3] * n[3],
  m[4] * n[0] + m[5] * n[2] + n[4], m[4] * n[1] + m[5] * n[3] + n[5],
];
const asMatrix = (a: unknown): M => {
  const src = (Array.isArray(a) && a.length === 1 ? a[0] : a) as ArrayLike<number>;
  return [src[0], src[1], src[2], src[3], src[4], src[5]].map(Number) as M;
};

// Only the page content is walked: annotation appearances (form fields,
// stamps) are drawn in their own space, and a field's border isn't a rule.
export async function pageEdges(page: PDFPageProxy, rotation?: number): Promise<Edges> {
  const { OPS, AnnotationMode } = await import("pdfjs-dist");
  const viewport = page.getViewport({ scale: 1, rotation });
  const list = await page.getOperatorList({ annotationMode: AnnotationMode.DISABLE });
  const h: Edge[] = [];
  const v: Edge[] = [];
  const images: Rect[] = [];
  const area = viewport.width * viewport.height;
  let ctm: M = [1, 0, 0, 1, 0, 0];
  const stack: M[] = [];
  // Text render mode, part of the graphics state: 3 draws nothing, 7 only clips.
  let mode = 0;
  const modes: number[] = [];
  const glyphs = { all: 0, hidden: 0 };

  const add = (ax: number, ay: number, bx: number, by: number) => {
    const [x0, y0] = viewport.convertToViewportPoint(ax * ctm[0] + ay * ctm[2] + ctm[4], ax * ctm[1] + ay * ctm[3] + ctm[5]);
    const [x1, y1] = viewport.convertToViewportPoint(bx * ctm[0] + by * ctm[2] + ctm[4], bx * ctm[1] + by * ctm[3] + ctm[5]);
    if (Math.abs(y1 - y0) < 0.8) h.push({ x0: Math.min(x0, x1), x1: Math.max(x0, x1), y0: (y0 + y1) / 2, y1: (y0 + y1) / 2 });
    else if (Math.abs(x1 - x0) < 0.8) v.push({ x0: (x0 + x1) / 2, x1: (x0 + x1) / 2, y0: Math.min(y0, y1), y1: Math.max(y0, y1) });
  };

  const { fnArray, argsArray } = list;
  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i];
    const a = argsArray[i] as unknown[];
    if (fn === OPS.save) {
      stack.push(ctm);
      modes.push(mode);
    } else if (fn === OPS.restore) {
      ctm = stack.pop() ?? ctm;
      mode = modes.pop() ?? mode;
    } else if (fn === OPS.transform) ctm = mul(asMatrix(a), ctm);
    else if (fn === OPS.paintFormXObjectBegin) {
      stack.push(ctm);
      modes.push(mode);
      if (a[0] && typeof a[0] === "object") ctm = mul(asMatrix(a[0]), ctm);
    } else if (fn === OPS.paintFormXObjectEnd) {
      ctm = stack.pop() ?? ctm;
      mode = modes.pop() ?? mode;
    } else if (fn === OPS.setTextRenderingMode) mode = Number(a[0]);
    else if (fn === OPS.showText) {
      // pdf.js turns every text-showing operator into showText: glyphs, and numbers for spacing.
      const n = ((a[0] ?? []) as unknown[]).filter((g) => g && typeof g === "object").length;
      glyphs.all += n;
      if (mode === 3 || mode === 7) glyphs.hidden += n;
    }
    else if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject || fn === OPS.paintImageMaskXObject) {
      // Images fill the unit square of the current matrix.
      const pts = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([x, y]) => viewport.convertToViewportPoint(x * ctm[0] + y * ctm[2] + ctm[4], x * ctm[1] + y * ctm[3] + ctm[5]));
      const xs = pts.map((p) => p[0]);
      const ys = pts.map((p) => p[1]);
      images.push({ x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) });
    } else if (fn === OPS.constructPath) {
      // pdf.js 6: [paint op, [path data], bbox]; path data is a flat list of
      // DrawOPS codes (0 moveTo, 1 lineTo, 2 curveTo, 3 quadraticCurveTo, 4 closePath).
      const paint = a[0] as number;
      if (paint === OPS.endPath) continue; // clipping only, nothing is drawn
      const data = (a[1] as ArrayLike<number>[] | undefined)?.[0];
      if (!data) continue;
      // A rectangle filling most of the page is a background, not a rule.
      const box = a[2] as ArrayLike<number> | undefined;
      if (box && Math.abs((box[2] - box[0]) * (box[3] - box[1]) * ctm[0] * ctm[3]) > area * 0.8) continue;
      let sx = 0, sy = 0, cx = 0, cy = 0;
      for (let k = 0; k < data.length; ) {
        const op = data[k];
        if (op === 0) { sx = cx = data[k + 1]; sy = cy = data[k + 2]; k += 3; }
        else if (op === 1) { add(cx, cy, data[k + 1], data[k + 2]); cx = data[k + 1]; cy = data[k + 2]; k += 3; }
        else if (op === 2) { cx = data[k + 5]; cy = data[k + 6]; k += 7; }
        else if (op === 3) { cx = data[k + 3]; cy = data[k + 4]; k += 5; }
        else if (op === 4) { if (cx !== sx || cy !== sy) add(cx, cy, sx, sy); cx = sx; cy = sy; k += 1; }
        else break; // unknown code: stop rather than misread the rest
      }
    }
  }
  return { h, v, images, glyphs };
}

// ── Snapping and joining

function cluster<T>(items: T[], key: (t: T) => number, tol: number): T[][] {
  const sorted = [...items].sort((p, q) => key(p) - key(q));
  const groups: T[][] = [];
  for (const it of sorted) {
    const g = groups[groups.length - 1];
    if (g && key(it) - key(g[g.length - 1]) <= tol) g.push(it);
    else groups.push([it]);
  }
  return groups;
}

export function mergeEdges({ h, v }: Edges): Edges {
  const merge = (edges: Edge[], horizontal: boolean) => {
    const pos = (e: Edge) => (horizontal ? e.y0 : e.x0);
    const start = (e: Edge) => (horizontal ? e.x0 : e.y0);
    const end = (e: Edge) => (horizontal ? e.x1 : e.y1);
    const out: Edge[] = [];
    for (const group of cluster(edges, pos, SNAP)) {
      const p = group.reduce((s, e) => s + pos(e), 0) / group.length;
      const spans = group.map((e) => [start(e), end(e)]).sort((a, b) => a[0] - b[0]);
      let [s, t] = spans[0];
      const flush = () => {
        if (t - s >= MIN_EDGE) out.push(horizontal ? { x0: s, x1: t, y0: p, y1: p } : { x0: p, x1: p, y0: s, y1: t });
      };
      for (const [a, b] of spans.slice(1)) {
        if (a <= t + JOIN) t = Math.max(t, b);
        else { flush(); [s, t] = [a, b]; }
      }
      flush();
    }
    return out;
  };
  return { h: merge(h, true), v: merge(v, false) };
}

// ── Cells from crossings

type Point = { x: number; y: number; hs: Set<number>; vs: Set<number> };
export type Rect = { x0: number; y0: number; x1: number; y1: number };

function crossings({ h, v }: Edges): Map<string, Point> {
  const pts = new Map<string, Point>();
  v.forEach((ve, vi) => {
    h.forEach((he, hi) => {
      if (he.y0 < ve.y0 - CROSS || he.y0 > ve.y1 + CROSS || ve.x0 < he.x0 - CROSS || ve.x0 > he.x1 + CROSS) return;
      const k = `${ve.x0.toFixed(2)},${he.y0.toFixed(2)}`;
      const p = pts.get(k) ?? { x: ve.x0, y: he.y0, hs: new Set(), vs: new Set() };
      p.hs.add(hi);
      p.vs.add(vi);
      pts.set(k, p);
    });
  });
  return pts;
}

const shares = (a: Set<number>, b: Set<number>) => [...a].some((x) => b.has(x));

function cells(pts: Map<string, Point>): Rect[] {
  const list = [...pts.values()].sort((p, q) => p.y - q.y || p.x - q.x);
  const key = (x: number, y: number) => `${x.toFixed(2)},${y.toFixed(2)}`;
  const out: Rect[] = [];
  for (const p of list) {
    const below = list.filter((q) => q.x === p.x && q.y > p.y);
    const right = list.filter((q) => q.y === p.y && q.x > p.x);
    search: for (const b of below) {
      if (!shares(p.vs, b.vs)) continue;
      for (const r of right) {
        if (!shares(p.hs, r.hs)) continue;
        const br = pts.get(key(r.x, b.y));
        if (br && shares(br.vs, r.vs) && shares(br.hs, b.hs)) {
          out.push({ x0: p.x, y0: p.y, x1: r.x, y1: b.y });
          break search;
        }
      }
    }
  }
  return out;
}

// Cells that share a corner belong to the same table.
function groupCells(rects: Rect[]): Rect[][] {
  const parent = rects.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const owner = new Map<string, number>();
  rects.forEach((r, i) => {
    for (const [x, y] of [[r.x0, r.y0], [r.x1, r.y0], [r.x0, r.y1], [r.x1, r.y1]]) {
      const k = `${x.toFixed(2)},${y.toFixed(2)}`;
      const o = owner.get(k);
      if (o === undefined) owner.set(k, i);
      else parent[find(i)] = find(o);
    }
  });
  const groups = new Map<number, Rect[]>();
  rects.forEach((r, i) => groups.set(find(i), [...(groups.get(find(i)) ?? []), r]));
  return [...groups.values()];
}

// ── Text into cells

// Splits a run where `inside` changes its answer (cell borders, link areas),
// using per-character positions when known.
export function pieces(run: Run, inside: (x: number, y: number) => number): { owner: number; run: Run }[] {
  // Turned text has no per-character positions across the page: it goes whole by its centre.
  if (run.turn) return [{ owner: inside(run.x + run.w / 2, run.y + run.h / 2), run }];
  const n = run.text.length;
  const xs = run.xs && run.xs.length === n + 1 ? run.xs : Array.from({ length: n + 1 }, (_, k) => run.x + (run.w * k) / n);
  const cy = run.y + run.h / 2;
  const out: { owner: number; run: Run }[] = [];
  let start = 0;
  let owner = inside((xs[0] + xs[1]) / 2, cy);
  const push = (end: number) => {
    const text = run.text.slice(start, end);
    if (text.trim()) out.push({ owner, run: { ...run, text, x: xs[start], w: xs[end] - xs[start], xs: xs.slice(start, end + 1) } });
  };
  for (let k = 1; k < n; k++) {
    if (run.text[k] === " ") continue; // spaces stay with the word before them
    const o = inside((xs[k] + xs[k + 1]) / 2, cy);
    if (o !== owner) {
      push(k);
      start = k;
      owner = o;
    }
  }
  push(n);
  return out;
}

const cellText = (lines: Line[]) =>
  lines.reduce((s, l) => (!s ? l.text : s.endsWith("-") && /^[a-z]/.test(l.text) ? s.slice(0, -1) + l.text : `${s} ${l.text}`), "");

function buildTable(rects: Rect[], ruled: boolean): Omit<Table, "cells"> & { cells: (TableCell & { rect: Rect; runs: Run[] })[] } {
  const xs = cluster([...new Set(rects.flatMap((r) => [r.x0, r.x1]))], (x) => x, 1).map((g) => g[0]);
  const ys = cluster([...new Set(rects.flatMap((r) => [r.y0, r.y1]))], (y) => y, 1).map((g) => g[0]);
  const near = (arr: number[], v: number) => arr.reduce((best, a, i) => (Math.abs(a - v) < Math.abs(arr[best] - v) ? i : best), 0);
  const cellsOut = rects.map((r) => {
    const col = near(xs, r.x0);
    const row = near(ys, r.y0);
    return {
      row, col, rowSpan: Math.max(1, near(ys, r.y1) - row), colSpan: Math.max(1, near(xs, r.x1) - col),
      x: r.x0, y: r.y0, w: r.x1 - r.x0, h: r.y1 - r.y0, text: "", bold: false, lines: [] as Line[], rect: r, runs: [] as Run[],
    };
  });
  return {
    x: xs[0], y: ys[0], w: xs[xs.length - 1] - xs[0], h: ys[ys.length - 1] - ys[0],
    rows: ys.length - 1, cols: xs.length - 1,
    colWidths: xs.slice(1).map((x, i) => x - xs[i]), rowHeights: ys.slice(1).map((y, i) => y - ys[i]),
    cells: cellsOut, ruled,
  };
}

// ── Columns for tables ruled only horizontally

// Regions bounded by two or more full-width rules with no vertical rules
// through them; the text between the first and last rule may be a table.
function ruledBands(edges: Edges, runs: Run[]): Rect[] {
  const bands: Rect[] = [];
  const hs = [...edges.h].filter((e) => e.x1 - e.x0 > 60).sort((a, b) => a.y0 - b.y0);
  const used = new Set<number>();
  for (let i = 0; i < hs.length; i++) {
    if (used.has(i)) continue;
    const top = hs[i];
    let last = -1;
    for (let j = i + 1; j < hs.length; j++) {
      const e = hs[j];
      if (Math.abs(e.x0 - top.x0) > 8 || Math.abs(e.x1 - top.x1) > 8) continue;
      // Stop at a big empty stretch: the rules belong to different tables.
      const prevY = last >= 0 ? hs[last].y0 : top.y0;
      const between = runs.filter((r) => r.y + r.h / 2 > prevY && r.y + r.h / 2 < e.y0);
      if (!between.length && e.y0 - prevY > 40) break;
      last = j;
      used.add(j);
    }
    if (last < 0) continue;
    const r = { x0: top.x0, x1: top.x1, y0: top.y0, y1: hs[last].y0 };
    const crossed = edges.v.some((v) => v.x0 > r.x0 + SNAP && v.x0 < r.x1 - SNAP && v.y0 < r.y1 && v.y1 > r.y0 && v.y1 - v.y0 > (r.y1 - r.y0) * 0.5);
    if (!crossed) bands.push(r);
  }
  return bands;
}

// Turns a band into cell rectangles: columns from vertical gaps that run
// through every text line, rows from the text lines themselves.
export function bandCells(band: Rect, runs: Run[]): Rect[] | null {
  const inside = runs.filter((r) => {
    const cx = r.x + r.w / 2;
    const cy = r.y + r.h / 2;
    return cx > band.x0 && cx < band.x1 && cy > band.y0 && cy < band.y1;
  });
  if (inside.length < 4) return null;
  const lines = groupLines(inside);
  if (lines.length < 2) return null;
  const size = lines.reduce((s, l) => s + l.size, 0) / lines.length;

  // Words, not runs: a run can hold two cells when their gap is small.
  const words: { x0: number; x1: number; line: number }[] = [];
  lines.forEach((l, li) => {
    for (const r of l.runs) {
      if (r.turn) {
        words.push({ x0: r.x, x1: r.x + r.w, line: li });
        continue;
      }
      const n = r.text.length;
      const xs = r.xs && r.xs.length === n + 1 ? r.xs : Array.from({ length: n + 1 }, (_, k) => r.x + (r.w * k) / n);
      let s = -1;
      for (let k = 0; k <= n; k++) {
        const space = k === n || r.text[k] === " ";
        if (!space && s < 0) s = k;
        if (space && s >= 0) {
          words.push({ x0: xs[s], x1: xs[k], line: li });
          s = -1;
        }
      }
    }
  });

  // A column gap is an x range no word covers, wide enough to separate cells.
  // Lines with a single word in the middle (centred titles, notes) may cross gaps.
  const step = 0.5;
  const width = Math.ceil((band.x1 - band.x0) / step);
  const covered = new Uint16Array(width);
  for (const w of words) {
    const a = Math.max(0, Math.floor((w.x0 - band.x0) / step));
    const b = Math.min(width, Math.ceil((w.x1 - band.x0) / step));
    for (let k = a; k < b; k++) covered[k]++;
  }
  const minGap = Math.max(size * 0.9, 6);
  const textX0 = Math.min(...words.map((w) => w.x0));
  const textX1 = Math.max(...words.map((w) => w.x1));
  const bounds = [band.x0];
  let runStart = -1;
  for (let k = 0; k <= width; k++) {
    const x = band.x0 + k * step;
    const free = k < width && covered[k] === 0 && x > textX0 && x < textX1;
    if (free && runStart < 0) runStart = k;
    if (!free && runStart >= 0) {
      if ((k - runStart) * step >= minGap) bounds.push(band.x0 + ((runStart + k) / 2) * step);
      runStart = -1;
    }
  }
  bounds.push(band.x1);
  const cols = bounds.length - 1;
  if (cols < 2) return null;

  // Tables have short cells; two columns of prose do not.
  const cellsPerLine = lines.map((l) => {
    const owners = new Set<number>();
    for (const r of l.runs) owners.add(bounds.findIndex((b, i) => i < cols && r.x + r.w / 2 >= b && r.x + r.w / 2 < bounds[i + 1]));
    return owners.size;
  });
  const avgChars = lines.reduce((s, l) => s + l.text.length, 0) / lines.length / cols;
  if (avgChars > 40 || cellsPerLine.filter((n) => n >= 2).length < Math.min(2, lines.length)) return null;

  // Row boundaries halfway between lines.
  const ys = [band.y0];
  for (let i = 1; i < lines.length; i++) {
    const prevBottom = Math.max(...lines[i - 1].runs.map((r) => r.y + r.h));
    ys.push((prevBottom + lines[i].y) / 2);
  }
  ys.push(band.y1);
  const out: Rect[] = [];
  for (let r = 0; r < ys.length - 1; r++)
    for (let c = 0; c < cols; c++) out.push({ x0: bounds[c], x1: bounds[c + 1], y0: ys[r], y1: ys[r + 1] });
  return out;
}

// ── Putting it together

// Fills cell rectangles with the runs inside them. Runs outside every table are returned as `rest`.
export function buildTables(groups: { rects: Rect[]; ruled: boolean }[], runs: Run[]): { tables: Table[]; rest: Run[] } {
  const tables = groups.map((g) => buildTable(g.rects, g.ruled));
  const flat = tables.flatMap((t, ti) => t.cells.map((c) => ({ t: ti, c })));
  const inside = (x: number, y: number) =>
    flat.findIndex(({ c }) => x >= c.rect.x0 && x <= c.rect.x1 && y >= c.rect.y0 && y <= c.rect.y1);

  const rest: Run[] = [];
  for (const run of runs) {
    for (const p of pieces(run, inside)) {
      if (p.owner < 0) rest.push(p.run);
      else flat[p.owner].c.runs.push(p.run);
    }
  }

  const out: Table[] = [];
  tables.forEach((t) => {
    const filled = t.cells.filter((c) => c.runs.length);
    // Ruled boxes with no text are page decoration (frames, form boxes).
    if (!filled.length || (t.rows * t.cols >= 4 && filled.length < 2)) {
      for (const c of t.cells) rest.push(...c.runs);
      return;
    }
    out.push({
      ...t,
      cells: t.cells
        .map(({ row, col, rowSpan, colSpan, x, y, w, h, runs }) => {
          const lines = groupLines(runs);
          return { row, col, rowSpan, colSpan, x, y, w, h, lines, text: cellText(lines), bold: lines.length > 0 && lines.every((l) => l.bold) };
        })
        .sort((a, b) => a.row - b.row || a.col - b.col),
    });
  });
  return { tables: out.sort((a, b) => a.y - b.y), rest };
}

export function findTables(page: PageText, raw: Edges): Layout {
  const edges = mergeEdges(raw);
  const groups: { rects: Rect[]; ruled: boolean }[] = [];

  for (const g of groupCells(cells(crossings(edges)))) {
    // A single box (a callout or a framed note) is not a table.
    if (g.length >= 2) groups.push({ rects: g, ruled: true });
  }
  const covered = (r: Rect) => groups.some((g) => g.rects.some((c) => r.x0 < c.x1 && r.x1 > c.x0 && r.y0 < c.y1 && r.y1 > c.y0));
  for (const band of ruledBands(edges, page.items)) {
    if (covered(band)) continue;
    const rects = bandCells(band, page.items);
    if (rects) groups.push({ rects, ruled: false });
  }
  const { tables, rest } = buildTables(groups, page.items);
  return { width: page.width, height: page.height, tables, lines: groupLines(rest), rest };
}

// Every line on the page, inside tables or not (for body-size statistics).
export const allLines = (l: Layout) => [...l.lines, ...l.tables.flatMap((t) => t.cells.flatMap((c) => c.lines))];

// Tables and the text around them in reading order (top to bottom).
export type Flow = ({ kind: "table"; table: Table } | { kind: "lines"; lines: Line[] })[];

export function flow(layout: Layout): Flow {
  const out: Flow = [];
  let li = 0;
  const lines = layout.lines;
  const pushLines = (until: number) => {
    const chunk: Line[] = [];
    while (li < lines.length && lines[li].y < until) chunk.push(lines[li++]);
    if (chunk.length) out.push({ kind: "lines", lines: chunk });
  };
  for (const t of layout.tables) {
    pushLines(t.y);
    out.push({ kind: "table", table: t });
  }
  pushLines(Infinity);
  return out;
}

// The table as a plain grid; merged cells fill their top-left slot.
export function grid(t: Table): (TableCell | null)[][] {
  const g: (TableCell | null)[][] = Array.from({ length: t.rows }, () => new Array(t.cols).fill(null));
  for (const c of t.cells) if (g[c.row]) g[c.row][c.col] = c;
  return g;
}

