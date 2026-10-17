"use client";

import { diffArrays, diffWordsWithSpace, type Change } from "diff";
import { closePdf, openPdf, renderPage } from "./common";
import { fileError } from "./errors";
import { documentText, plainText } from "./text";

// One row of the comparison: a page of the original (`a`) and the page of
// the revised file (`b`) it lines up with. A page only one file has gets
// null on the other side.
export type PagePair = { a: number | null; b: number | null };
export type PageDiff = PagePair & {
  status: "same" | "changed" | "added" | "removed";
  changes: Change[];
  added: number;
  removed: number;
};

const wordSet = (text: string) => new Set(text.toLowerCase().split(/\s+/).filter(Boolean));

// The same page, edited: at least half the words either page uses are on
// both (Jaccard >= 0.5, so shared >= (x + y) / 3). Stops as soon as the
// answer is known; most pairs of a long document are far apart.
function samePage(x: Set<string>, y: Set<string>) {
  if (!x.size || !y.size) return x.size === y.size;
  const need = (x.size + y.size) / 3;
  const [small, large] = x.size < y.size ? [x, y] : [y, x];
  let shared = 0;
  let left = small.size;
  for (const w of small) {
    if (large.has(w)) shared++;
    if (shared >= need) return true;
    if (shared + --left < need) return false;
  }
  return false;
}

// Lines pages up by content (a longest common subsequence over "similar
// enough" pages, Jaccard of word sets), so inserting or deleting a page
// doesn't shift every page after it. Unmatched pages between two matches
// pair up in order, as pages rewritten in place; the rest were added or
// removed.
export function alignPages(ta: string[], tb: string[]): PagePair[] {
  const wa = ta.map(wordSet);
  const wb = tb.map(wordSet);
  const parts = diffArrays(ta.map((_, i) => i), tb.map((_, i) => i), {
    comparator: (i: number, j: number) => samePage(wa[i], wb[j]),
  });
  const out: PagePair[] = [];
  let ia = 0;
  let ib = 0;
  let gapA: number[] = [];
  let gapB: number[] = [];
  const flush = () => {
    const n = Math.max(gapA.length, gapB.length);
    for (let k = 0; k < n; k++) out.push({ a: gapA[k] ?? null, b: gapB[k] ?? null });
    gapA = [];
    gapB = [];
  };
  for (const part of parts) {
    const count = part.count ?? part.value.length;
    if (part.removed) for (let k = 0; k < count; k++) gapA.push(ia++);
    else if (part.added) for (let k = 0; k < count; k++) gapB.push(ib++);
    else {
      flush();
      for (let k = 0; k < count; k++) out.push({ a: ia++, b: ib++ });
    }
  }
  flush();
  return out;
}

const words = (changes: Change[], side: "added" | "removed") =>
  changes.filter((c) => c[side]).reduce((s, c) => s + c.value.trim().split(/\s+/).filter(Boolean).length, 0);

// Runs one file's part, so a failure names the file it's about and says
// which side it was (two files can share a name).
async function onSide<T>(file: File, side: "a" | "b", work: () => Promise<T>) {
  try {
    return await work();
  } catch (e) {
    throw Object.assign(await fileError(e, file), { side });
  }
}

// Each file is opened on its own, the original first.
async function openBoth(a: File, b: File) {
  const da = await onSide(a, "a", async () => openPdf(await a.arrayBuffer()));
  try {
    return [da, await onSide(b, "b", async () => openPdf(await b.arrayBuffer()))] as const;
  } catch (e) {
    await closePdf(da);
    throw e;
  }
}

export async function textDiff(a: File, b: File): Promise<PageDiff[]> {
  const [da, db] = await openBoth(a, b);
  try {
    const [pa, pb] = await Promise.all([onSide(a, "a", () => documentText(da)), onSide(b, "b", () => documentText(db))]);
    const ta = pa.map(plainText);
    const tb = pb.map(plainText);
    return alignPages(ta, tb).map((pair) => {
      const changes = diffWordsWithSpace(pair.a === null ? "" : ta[pair.a], pair.b === null ? "" : tb[pair.b]);
      const added = words(changes, "added");
      const removed = words(changes, "removed");
      const status = pair.a === null ? "added" : pair.b === null ? "removed" : added || removed ? "changed" : "same";
      return { ...pair, status, changes, added, removed };
    });
  } finally {
    await Promise.all([closePdf(da), closePdf(db)]);
  }
}

// One aligned row drawn over itself: the original in red, the revised page
// in blue, ink they share in dark grey. A missing side is a blank page.
export async function visualOverlay(a: File, b: File, pair: PagePair, width: number) {
  const [da, db] = await openBoth(a, b);
  try {
    const get = async (d: typeof da, index: number | null) => {
      if (index === null || index >= d.numPages) return null;
      const page = await d.getPage(index + 1);
      const v = page.getViewport({ scale: 1 });
      return renderPage(page, width / v.width);
    };
    const [ca, cb] = await Promise.all([onSide(a, "a", () => get(da, pair.a)), onSide(b, "b", () => get(db, pair.b))]);
    const w = Math.max(ca?.width ?? 0, cb?.width ?? 0);
    const h = Math.max(ca?.height ?? 0, cb?.height ?? 0);
    const out = document.createElement("canvas");
    out.width = w;
    out.height = h;
    const ctx = out.getContext("2d")!;
    const read = (c: HTMLCanvasElement | null) => {
      if (!c) return null;
      const t = document.createElement("canvas");
      t.width = w;
      t.height = h;
      const tc = t.getContext("2d")!;
      tc.fillStyle = "#fff";
      tc.fillRect(0, 0, w, h);
      tc.drawImage(c, 0, 0);
      return tc.getImageData(0, 0, w, h).data;
    };
    const pa = read(ca);
    const pb = read(cb);
    const img = ctx.createImageData(w, h);
    let changed = 0;
    for (let i = 0; i < img.data.length; i += 4) {
      const ga = pa ? (pa[i] + pa[i + 1] + pa[i + 2]) / 3 : 255;
      const gb = pb ? (pb[i] + pb[i + 1] + pb[i + 2]) / 3 : 255;
      const inkA = ga < 200;
      const inkB = gb < 200;
      if (inkA && inkB) img.data.set([90, 96, 110, 255], i);
      else if (inkA) { img.data.set([220, 38, 38, 255], i); changed++; }
      else if (inkB) { img.data.set([37, 99, 235, 255], i); changed++; }
      else img.data.set([255, 255, 255, 255], i);
    }
    ctx.putImageData(img, 0, 0);
    return { canvas: out, changed };
  } finally {
    await Promise.all([closePdf(da), closePdf(db)]);
  }
}
