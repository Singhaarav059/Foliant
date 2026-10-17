"use client";

import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import { VENDOR } from "../vendor";

// `print`: the blob is HTML to save through the browser's print dialog (static build).
export type Output = { name: string; blob: Blob; note?: string; print?: boolean };
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
  }).promise;
}

// Frees the worker-side copy of a document.
export const closePdf = (doc: PDFDocumentProxy) => doc.loadingTask.destroy();

// `withoutText` leaves out the text-drawing operators: what's left is the
// page's pictures and vector art.
export async function renderPage(page: PDFPageProxy, scale: number, background = "#ffffff", withoutText = false) {
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(viewport.width));
  canvas.height = Math.max(1, Math.round(viewport.height));
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  let operationsFilter: ((i: number, list: { fnArray: number[] }) => boolean) | undefined;
  if (withoutText) {
    const { OPS } = await pdfjs();
    const text = new Set([OPS.showText, OPS.showSpacedText, OPS.nextLineShowText, OPS.nextLineSetSpacingShowText]);
    operationsFilter = (i, list) => !text.has(list.fnArray[i]);
  }
  // "print" renders without requestAnimationFrame, which browsers pause in
  // background tabs; a long job keeps going when the user switches away.
  await page.render({ canvas, canvasContext: ctx, viewport, intent: "print", operationsFilter }).promise;
  return canvas;
}

export function canvasToBlob(canvas: HTMLCanvasElement, type = "image/jpeg", quality = 0.9) {
  return new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Canvas export failed"))), type, quality),
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

export async function loadImage(blob: Blob): Promise<ImageBitmap> {
  return createImageBitmap(blob, { imageOrientation: "from-image" });
}

// Converts any browser-decodable image to JPEG or PNG bytes pdf-lib can embed.
export async function normaliseImage(file: Blob): Promise<{ bytes: Uint8Array; kind: "jpg" | "png"; width: number; height: number }> {
  const type = file.type;
  const bmp = await loadImage(file);
  const { width, height } = bmp;
  if (type === "image/jpeg") {
    bmp.close();
    return { bytes: await bytesOf(file), kind: "jpg", width, height };
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  canvas.getContext("2d")!.drawImage(bmp, 0, 0);
  bmp.close();
  const png = type === "image/png";
  const blob = await canvasToBlob(canvas, png ? "image/png" : "image/jpeg", 0.92);
  return { bytes: await bytesOf(blob), kind: png ? "png" : "jpg", width, height };
}
