"use client";

import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import { VENDOR } from "../vendor";
import { PdfError } from "./errors";

// `print`: the blob is HTML to save through the browser's print dialog (static build).
// `unrestricted`: an input's owner-password restrictions were left behind.
// `skipped`: files, or pages of a file, that failed and were left out while the rest came through.
export type Skipped = { file: string; page?: number; code: string };
// `report`: what a tool checked about its result (redaction, PDF/A), shown with it.
export type Output = { name: string; blob: Blob; note?: string; print?: boolean; unrestricted?: boolean; skipped?: Skipped[]; report?: Report };
// Redaction: boxes drawn, searched texts, and how many of them a fresh read of
// the result still finds (pdf.js text, and OCR of scanned pages; null when OCR
// couldn't run); what else went: annotations, attached files, document properties.
export type RedactReport = {
  kind: "redact"; areas: number; pages: number; terms: number; textLeft: number; ocrPages: number; ocrLeft: number | null;
  annots: number; attachments: number; metadata: string[];
};
// PDF/A: the checks run on the result (src/lib/pdf/pdfacheck.ts) and what failed, by ISO 19005 clause.
export type PdfaCheckReport = { kind: "pdfa"; level: string; checked: number; issues: { rule: string; clause: string; detail?: string }[] };
export type Report = RedactReport | PdfaCheckReport;
export type Progress = (done: number, total: number) => void;

let pdfjsPromise: Promise<typeof import("pdfjs-dist")> | null = null;

export function pdfjs() {
  pdfjsPromise ??= import("pdfjs-dist").then((lib) => {
    // Copied to /vendor by scripts/vendor.mjs so the worker version always matches.
    lib.GlobalWorkerOptions.workerSrc = `${VENDOR}pdf.worker.min.mjs`;
    return lib;
  });
  return pdfjsPromise;
}

// How big a page may be drawn. iOS refuses canvases over about 16.7 million
// pixels and a tab there has little memory; elsewhere a page gets 64 million
// (256 MB as RGBA, about as much again while it's encoded). No side over
// 16,384 px, the smallest limit among browsers.
// Pictures inside a PDF over `image` pixels aren't decoded at all (a
// 20,000 x 20,000 one takes gigabytes) and are left out of the drawing; an A0
// scan at 300 dpi (140 million) still fits. Those over the page budget are
// shrunk in pdf.js's worker before they reach the page.
const ios = typeof navigator !== "undefined" &&
  (/iP(hone|ad|od)/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1));
export const renderLimits = ios ? { pixels: 16e6, side: 16384, image: 50e6 } : { pixels: 64e6, side: 16384, image: 200e6 };

// The scale a page is drawn at: `scale`, or less when that would go over
// renderLimits, or over `pixels` when the caller needs less (OCR).
export function fitScale(page: PDFPageProxy, scale: number, rotation?: number, budget = renderLimits.pixels) {
  const { width, height } = page.getViewport({ scale: 1, rotation });
  const { side } = renderLimits;
  const pixels = Math.min(budget, renderLimits.pixels);
  // Rounded canvas sides must stay within the limits too.
  const fit = Math.min((side - 0.5) / Math.max(width, height), Math.sqrt((pixels * 0.999) / Math.max(1e-9, width * height)));
  return Math.min(scale, fit);
}

export async function openPdf(data: ArrayBuffer | Uint8Array, password?: string): Promise<PDFDocumentProxy> {
  const lib = await pdfjs();
  // pdf.js transfers the buffer to its worker, so hand it a copy.
  const bytes = data instanceof Uint8Array ? data.slice() : new Uint8Array(data.slice(0));
  return lib.getDocument({
    data: bytes,
    password,
    // Font names ("Helvetica-Bold"), so converters can tell bold, italic and the family.
    fontExtraProperties: true,
    // Copied by scripts/vendor.mjs.
    cMapUrl: `${VENDOR}pdfjs/cmaps/`,
    standardFontDataUrl: `${VENDOR}pdfjs/standard_fonts/`,
    wasmUrl: `${VENDOR}pdfjs/wasm/`,
    iccUrl: `${VENDOR}pdfjs/iccs/`,
    maxImageSize: renderLimits.image,
    canvasMaxAreaInBytes: renderLimits.pixels * 4,
  }).promise;
}

// Frees the worker-side copy of a document.
export const closePdf = (doc: PDFDocumentProxy) => doc.loadingTask.destroy();

// `rotation` overrides the page's own, to draw it in the view a layout was
// read in. `withoutText` leaves out the text-drawing operators: what's left is
// the page's pictures and vector art. A page too big for renderLimits is drawn
// at the largest scale that fits (fitScale says which). `signal` stops the drawing.
export async function renderPage(page: PDFPageProxy, scale: number, background = "#ffffff", o: { rotation?: number; withoutText?: boolean; signal?: AbortSignal } = {}) {
  const { rotation, withoutText = false, signal } = o;
  signal?.throwIfAborted();
  const viewport = page.getViewport({ scale: fitScale(page, scale, rotation), rotation });
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(viewport.width));
  canvas.height = Math.max(1, Math.round(viewport.height));
  const ctx = canvas.getContext("2d")!;
  let operationsFilter: ((i: number, list: { fnArray: number[] }) => boolean) | undefined;
  if (withoutText) {
    const { OPS } = await pdfjs();
    const text = new Set([OPS.showText, OPS.showSpacedText, OPS.nextLineShowText, OPS.nextLineSetSpacingShowText]);
    operationsFilter = (i, list) => !text.has(list.fnArray[i]);
  }
  // "print" renders without requestAnimationFrame, which browsers pause in
  // background tabs; a long job keeps going when the user switches away.
  // pdf.js paints `background` under the page; a clear one leaves it transparent.
  const task = page.render({ canvas, canvasContext: ctx, viewport, intent: "print", operationsFilter, background });
  const stop = () => task.cancel();
  signal?.addEventListener("abort", stop, { once: true });
  try {
    await task.promise;
  } catch (e) {
    canvas.width = canvas.height = 0;
    throw signal?.aborted ? signal.reason : e;
  } finally {
    signal?.removeEventListener("abort", stop);
  }
  return canvas;
}

// `work`, or the abort's reason as soon as `signal` fires. The work itself
// goes on unless its owner stops it too (terminating a worker, say).
export function abortable<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const stop = () => reject(signal.reason);
    signal.addEventListener("abort", stop, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", stop));
  });
}

// Lets the page handle input (a click on Cancel) and paint between steps of
// work done on the main thread. A message goes to the back of the task queue,
// behind the clicks waiting there. Not a timer, which background tabs slow to
// one a second, nor scheduler.yield(), which resumes ahead of them.
export function yieldToPage(): Promise<void> {
  return new Promise((resolve) => {
    const c = new MessageChannel();
    c.port1.onmessage = () => {
      c.port1.close();
      resolve();
    };
    c.port2.postMessage(0);
  });
}

export function canvasToBlob(canvas: HTMLCanvasElement, type = "image/jpeg", quality = 0.9) {
  // toBlob gives null when the canvas is over the browser's size limit.
  return new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new PdfError("page_too_large"))), type, quality),
  );
}

export const bytesOf = async (blob: Blob) => new Uint8Array(await blob.arrayBuffer());
export const pdfBlob = (bytes: Uint8Array) => new Blob([bytes as BlobPart], { type: "application/pdf" });

export function baseName(name: string) {
  return name.replace(/\.[^.]+$/, "");
}

// "1-3, 5, 8-" → [[0,1,2],[4],[7..last]] (zero-based, clamped, empty ranges dropped).
export function parseRanges(input: string, total: number): number[][] {
  const groups: number[][] = [];
  for (const raw of input.split(/[,;]+/)) {
    const part = raw.trim();
    if (!part) continue;
    const m = part.match(/^(\d*)\s*[-–]\s*(\d*)$/);
    let from: number, to: number;
    if (m) {
      from = m[1] ? Number(m[1]) : 1;
      to = m[2] ? Number(m[2]) : total;
    } else if (/^\d+$/.test(part)) {
      from = to = Number(part);
    } else continue;
    if (from > to) [from, to] = [to, from];
    from = Math.max(1, from);
    to = Math.min(total, to);
    if (from > total) continue;
    const g: number[] = [];
    for (let i = from; i <= to; i++) g.push(i - 1);
    if (g.length) groups.push(g);
  }
  return groups;
}

// A page set from a range string; empty means every page.
export function pageSet(input: string | undefined, total: number) {
  if (!input || !input.trim() || input.trim().toLowerCase() === "all") {
    return new Set(Array.from({ length: total }, (_, i) => i));
  }
  return new Set(parseRanges(input, total).flat());
}

export function hexToRgb(hex: string) {
  const h = hex.replace("#", "");
  const n = parseInt(h.length === 3 ? h.replace(/./g, "$&$&") : h, 16);
  return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 };
}

// Helvetica in pdf-lib only covers WinAnsi. Anything outside it (CJK, Arabic,
// Devanagari…) is drawn as a crisp image of the text instead.
export function isWinAnsi(text: string) {
  return /^[\x20-\x7e\xa0-\xff–—‘’“”•…€\n]*$/.test(text);
}

export async function textToPng(text: string, sizePt: number, color: string, font = "600 {s}px system-ui, sans-serif") {
  const scale = 4; // render at 4× so the image stays sharp when zoomed
  const px = sizePt * scale;
  const probe = document.createElement("canvas").getContext("2d")!;
  probe.font = font.replace("{s}", String(px));
  const lines = text.split("\n");
  const width = Math.ceil(Math.max(...lines.map((l) => probe.measureText(l).width)) + px * 0.2);
  const lineH = Math.ceil(px * 1.25);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, width);
  canvas.height = lineH * lines.length;
  const ctx = canvas.getContext("2d")!;
  ctx.font = probe.font;
  ctx.fillStyle = color;
  ctx.textBaseline = "top";
  lines.forEach((l, i) => ctx.fillText(l, px * 0.1, i * lineH + px * 0.1));
  return { png: await bytesOf(await canvasToBlob(canvas, "image/png")), width: canvas.width / scale, height: canvas.height / scale };
}

export function fileExt(name: string) {
  return (name.split(".").pop() || "").toLowerCase();
}

export function humanSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

// The first image of a file as upright JPEG or PNG bytes pdf-lib can embed
// (the watermark image). Images → PDF uses pdfImages (./images) directly.
export async function normaliseImage(file: Blob): Promise<{ bytes: Uint8Array; kind: "jpg" | "png"; width: number; height: number }> {
  const { pdfImages } = await import("./images");
  for await (const img of pdfImages(file, { upright: true })) return img;
  throw new PdfError("image_unsupported", (file as File).name ?? "");
}
