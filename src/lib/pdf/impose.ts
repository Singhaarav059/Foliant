"use client";

// Print and scan helpers (P2-10):
//   nUp          2, 4 or 9 pages on each sheet
//   booklet      pages in saddle-stitch order, two to a side, to fold in half
//   removeBlank  pages with (almost) no ink dropped, judged from a rendering
//   mix          two or more files interleaved, for double-sided scans
//   resize       every page scaled onto A4, Letter or another paper size
// Sheets are built from form XObjects (pdf-lib's embedPage), which keep the
// pages' text and vectors as they are.

import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, degrees, rgb, type PDFEmbeddedPage, type PDFPage } from "pdf-lib";
import { baseName, bytesOf, closePdf, openPdf, pdfBlob, renderPage, yieldToPage, type Output, type Progress } from "./common";
import { isolate, viewBox, visualFrame } from "./edit";
import { buildFromPlan, loadPdf } from "./organize";
import { PdfError } from "./errors";

// Paper sizes in points, portrait.
export const PAPER: Record<string, [number, number]> = {
  a4: [595.28, 841.89], letter: [612, 792], a3: [841.89, 1190.55], a5: [419.53, 595.28], legal: [612, 1008],
};

const save = async (doc: PDFDocument) => pdfBlob(await doc.save({ useObjectStreams: true, addDefaultPage: false }));

// A page as it is shown: its visible box embedded, and the size and turn it is seen at.
type Shown = { form: PDFEmbeddedPage; w: number; h: number; rot: number };
async function shownPages(src: PDFDocument, out: PDFDocument): Promise<Shown[]> {
  const pages = src.getPages();
  const boxes = pages.map((p) => {
    const b = viewBox(p);
    return { left: b.x, bottom: b.y, right: b.x + b.width, top: b.y + b.height };
  });
  const forms = await out.embedPages(pages, boxes);
  return pages.map((p, i) => {
    const { vw, vh, rot } = visualFrame(p);
    return { form: forms[i], w: vw, h: vh, rot };
  });
}

// Draws a page into the box (x, y, w, h) on a sheet, as large as fits, centred.
function place(sheet: PDFPage, p: Shown, x: number, y: number, w: number, h: number, frame = false) {
  const s = Math.min(w / p.w, h / p.h);
  const dw = p.w * s, dh = p.h * s;
  const x0 = x + (w - dw) / 2, y0 = y + (h - dh) / 2;
  // The form is drawn unrotated at its own size (fw × fh) and turned clockwise
  // by the page's /Rotate; each turn moves its corner back into the box.
  const fw = p.form.width * s, fh = p.form.height * s;
  const at: Record<number, [number, number]> = { 0: [x0, y0], 90: [x0, y0 + fw], 180: [x0 + fw, y0 + fh], 270: [x0 + fh, y0] };
  const [px, py] = at[p.rot] ?? at[0];
  sheet.drawPage(p.form, { x: px, y: py, xScale: s, yScale: s, rotate: degrees(-p.rot) });
  if (frame) sheet.drawRectangle({ x: x0, y: y0, width: dw, height: dh, borderColor: rgb(0.6, 0.6, 0.6), borderWidth: 0.5 });
}

// The sheet for `per` pages of size (w, h): the paper asked for, or the page's
// own size; turned so the grid's cells match the pages' shape.
function sheetFor(per: number, w: number, h: number, paper: string) {
  const portrait = h >= w;
  const [cols, rows] = per === 2 ? (portrait ? [2, 1] : [1, 2]) : per === 9 ? [3, 3] : [2, 2];
  let [sw, sh] = PAPER[paper] ?? [w, h];
  if (!PAPER[paper] && per === 2) [sw, sh] = [h, w];
  // Two portrait pages side by side want a landscape sheet, and the reverse.
  const landscape = per === 2 ? portrait : !portrait;
  if (landscape !== sw > sh) [sw, sh] = [sh, sw];
  return { sw, sh, cols, rows };
}

const MARGIN = 0.03;

export async function nUp(file: File, o: { per: number; paper: string; frame: boolean }, progress?: Progress): Promise<Output[]> {
  const src = await loadPdf(file, file.name);
  const out = await PDFDocument.create();
  const pages = await shownPages(src, out);
  const per = [2, 4, 9].includes(o.per) ? o.per : 2;
  const first = pages[0];
  if (!first) throw new PdfError("damaged", file.name);
  const { sw, sh, cols, rows } = sheetFor(per, first.w, first.h, o.paper);
  const m = Math.min(sw, sh) * MARGIN;
  const cw = (sw - 2 * m) / cols, ch = (sh - 2 * m) / rows;
  for (let i = 0; i < pages.length; i += per) {
    progress?.(i, pages.length);
    const sheet = out.addPage([sw, sh]);
    for (let k = 0; k < per && i + k < pages.length; k++) {
      // Left to right, top to bottom.
      const c = k % cols, r = Math.floor(k / cols);
      place(sheet, pages[i + k], m + c * cw + m / 4, sh - m - (r + 1) * ch + m / 4, cw - m / 2, ch - m / 2, o.frame);
    }
  }
  return [{ name: `${baseName(file.name)}-${per}-up.pdf`, blob: await save(out) }];
}

// Saddle-stitch order for n pages (a multiple of 4): each sheet's front and
// back, left page then right page, 1-based. 8 pages: [8,1],[2,7],[6,3],[4,5].
export function bookletOrder(n: number): [number, number][] {
  const sides: [number, number][] = [];
  for (let i = 0; i < n / 4; i++) {
    sides.push([n - 2 * i, 2 * i + 1]);
    sides.push([2 * i + 2, n - 2 * i - 1]);
  }
  return sides;
}

export async function booklet(file: File, o: { paper: string; binding: string }, progress?: Progress): Promise<Output[]> {
  const src = await loadPdf(file, file.name);
  const out = await PDFDocument.create();
  const pages = await shownPages(src, out);
  if (!pages.length) throw new PdfError("damaged", file.name);
  const n = Math.ceil(pages.length / 4) * 4;
  const { sw, sh } = sheetFor(2, pages[0].w, pages[0].h, o.paper);
  const half = sw / 2;
  const m = Math.min(sw, sh) * MARGIN;
  const order = bookletOrder(n);
  for (const [k, side] of order.entries()) {
    progress?.(k, order.length);
    const sheet = out.addPage([sw, sh]);
    // Bound on the right (right-to-left scripts), each side reads the other way round.
    const [l, r] = o.binding === "right" ? [side[1], side[0]] : side;
    // Pages past the end are left blank; the gutter is the sheet's middle.
    if (pages[l - 1]) place(sheet, pages[l - 1], m, m, half - 1.5 * m, sh - 2 * m);
    if (pages[r - 1]) place(sheet, pages[r - 1], half + m / 2, m, half - 1.5 * m, sh - 2 * m);
  }
  return [{ name: `${baseName(file.name)}-booklet.pdf`, blob: await save(out) }];
}

// ── Blank pages. A page is blank when the share of dark pixels in a small
// rendering, margins left out (scanner edges and punch holes), is under the
// level's limit.
// A short line of text is about 0.03% of a page; scanner specks at "lenient"
// stay under its limit.
const BLANK: Record<string, { ink: number; share: number }> = {
  strict: { ink: 240, share: 0.00001 },
  normal: { ink: 180, share: 0.00005 },
  lenient: { ink: 120, share: 0.0005 },
};

export function inkShare(data: Uint8ClampedArray | Uint8Array, w: number, h: number, dark: number) {
  const mx = Math.floor(w * 0.04), my = Math.floor(h * 0.04);
  let ink = 0, all = 0;
  for (let y = my; y < h - my; y++) {
    for (let x = mx; x < w - mx; x++) {
      const i = (y * w + x) * 4;
      const l = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      all++;
      if (l < dark) ink++;
    }
  }
  return all ? ink / all : 0;
}

export async function blankPages(bytes: Uint8Array, level: string, progress?: Progress, signal?: AbortSignal) {
  const { ink, share } = BLANK[level] ?? BLANK.normal;
  const pdf = await openPdf(bytes.slice());
  const blank: number[] = [];
  try {
    for (let i = 1; i <= pdf.numPages; i++) {
      signal?.throwIfAborted();
      progress?.(i - 1, pdf.numPages);
      const page = await pdf.getPage(i);
      // About 50 dpi: enough to see a line of text, small enough to be quick.
      const canvas = await renderPage(page, 50 / 72, "#ffffff", { signal });
      const img = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height);
      if (inkShare(img.data, canvas.width, canvas.height, ink) < share) blank.push(i - 1);
      canvas.width = canvas.height = 0;
      page.cleanup();
      await yieldToPage();
    }
  } finally {
    await closePdf(pdf);
  }
  return blank;
}

export async function removeBlank(file: File, o: { level: string }, progress?: Progress, signal?: AbortSignal): Promise<Output[]> {
  const bytes = await bytesOf(file);
  const blank = new Set(await blankPages(bytes, o.level, progress, signal));
  const name = `${baseName(file.name)}-no-blank-pages.pdf`;
  if (!blank.size) return [{ name, blob: pdfBlob(bytes), note: "blankNone" }];
  const total = (await loadPdf(file, file.name)).getPageCount();
  if (blank.size === total) throw new PdfError("all_blank", file.name);
  const plan = Array.from({ length: total }, (_, page) => ({ file: 0, page, rotate: 0 })).filter((p) => !blank.has(p.page));
  return [{ name, blob: await buildFromPlan([file], plan, { extract: true }), note: `blankRemoved:${blank.size}` }];
}

// ── Alternate and mix: page 1 of each file, then page 2 of each, and so on;
// a file that runs out is skipped. `reverse` takes the second file back to
// front, as a stack of back sides comes out of a scanner.
export async function mix(files: File[], o: { reverse: boolean }): Promise<Output[]> {
  const counts: number[] = [];
  for (const f of files) counts.push((await loadPdf(f, f.name)).getPageCount());
  const plan: { file: number; page: number; rotate: number }[] = [];
  for (let i = 0; i < Math.max(...counts); i++) {
    for (let fi = 0; fi < files.length; fi++) {
      if (i >= counts[fi]) continue;
      const page = o.reverse && fi === 1 ? counts[fi] - 1 - i : i;
      plan.push({ file: fi, page, rotate: 0 });
    }
  }
  return [{ name: `${baseName(files[0].name)}-mixed.pdf`, blob: await buildFromPlan(files, plan) }];
}

// ── Resize: each page's content scaled to fit the paper, centred, turned
// the way the page is shown (landscape pages on landscape paper). Links and
// other annotations move with it.
export async function resize(file: File, o: { paper: string }): Promise<Output[]> {
  const doc = await loadPdf(file, file.name);
  const [pw, ph] = PAPER[o.paper] ?? PAPER.a4;
  for (const page of doc.getPages()) {
    const box = viewBox(page);
    const { vw, vh, rot } = visualFrame(page);
    // Target in the page's own (unrotated) axes.
    const landscape = vw > vh;
    let [tw, th] = landscape ? [ph, pw] : [pw, ph];
    if (rot === 90 || rot === 270) [tw, th] = [th, tw];
    const s = Math.min(tw / box.width, th / box.height);
    const dx = (tw - box.width * s) / 2 - box.x * s;
    const dy = (th - box.height * s) / 2 - box.y * s;
    isolate(page);
    const ctx = doc.context;
    const pre = ctx.register(ctx.stream(`q ${s} 0 0 ${s} ${dx} ${dy} cm`));
    const post = ctx.register(ctx.stream("Q"));
    page.node.wrapContentStreams(pre, post);
    for (const k of ["CropBox", "BleedBox", "TrimBox", "ArtBox"]) page.node.delete(PDFName.of(k));
    page.node.set(PDFName.of("MediaBox"), ctx.obj([0, 0, tw, th]));
    const map = (x: number, y: number) => [x * s + dx, y * s + dy];
    for (const a of page.node.Annots()?.asArray() ?? []) {
      const d = ctx.lookup(a);
      if (!(d instanceof PDFDict)) continue;
      for (const key of ["Rect", "QuadPoints", "L", "Vertices", "CL"]) {
        const arr = d.lookup(PDFName.of(key));
        if (arr instanceof PDFArray) movePoints(arr, map);
      }
      const ink = d.lookup(PDFName.of("InkList"));
      if (ink instanceof PDFArray) for (const path of ink.asArray()) { const p = ctx.lookup(path); if (p instanceof PDFArray) movePoints(p, map); }
      // An appearance drawn for the old size is scaled by the viewer to the new /Rect.
    }
  }
  return [{ name: `${baseName(file.name)}-${o.paper}.pdf`, blob: await save(doc) }];
}

function movePoints(arr: PDFArray, map: (x: number, y: number) => number[]) {
  for (let i = 0; i + 1 < arr.size(); i += 2) {
    const x = arr.lookup(i), y = arr.lookup(i + 1);
    if (!(x instanceof PDFNumber) || !(y instanceof PDFNumber)) continue;
    const [nx, ny] = map(x.asNumber(), y.asNumber());
    arr.set(i, PDFNumber.of(nx));
    arr.set(i + 1, PDFNumber.of(ny));
  }
}

