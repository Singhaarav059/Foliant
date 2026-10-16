"use client";

import type { PDFDocumentProxy } from "pdfjs-dist";
import { closePdf, openPdf } from "./common";

// One open pdf.js document per File, shared by every thumbnail and editor view.
const docs = new WeakMap<Blob, Promise<PDFDocumentProxy>>();

export function docFor(file: Blob, password?: string) {
  let p = docs.get(file);
  if (!p) {
    p = file.arrayBuffer().then((b) => openPdf(b, password));
    docs.set(file, p);
    p.catch(() => docs.delete(file));
  }
  return p;
}

export async function forgetDoc(file: Blob) {
  const p = docs.get(file);
  docs.delete(file);
  if (p) closePdf(await p).catch(() => {});
}

// Renders run two at a time so a 300-page file doesn't freeze the tab.
let active = 0;
const queue: (() => void)[] = [];
async function slot<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= 2) await new Promise<void>((r) => queue.push(r));
  active++;
  try {
    return await fn();
  } finally {
    active--;
    queue.shift()?.();
  }
}

const cache = new WeakMap<Blob, Map<string, string>>();

// Returns an object URL for a page image at the given CSS width (rendered at device pixel ratio).
export function thumbUrl(file: Blob, pageIndex: number, cssWidth: number, signal?: AbortSignal): Promise<{ url: string; ratio: number }> {
  const dpr = Math.min(2, typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1);
  const key = `${pageIndex}:${Math.round(cssWidth * dpr)}`;
  const hit = cache.get(file)?.get(key);
  if (hit) {
    const [url, ratio] = hit.split("|");
    return Promise.resolve({ url, ratio: Number(ratio) });
  }
  return slot(async () => {
    if (signal?.aborted) throw new DOMException("aborted", "AbortError");
    const doc = await docFor(file);
    const page = await doc.getPage(pageIndex + 1);
    const base = page.getViewport({ scale: 1 });
    const scale = (cssWidth * dpr) / base.width;
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvas, canvasContext: ctx, viewport }).promise;
    const blob = await new Promise<Blob>((r) => canvas.toBlob((b) => r(b!), "image/jpeg", 0.85));
    const url = URL.createObjectURL(blob);
    const ratio = base.height / base.width;
    let m = cache.get(file);
    if (!m) cache.set(file, (m = new Map()));
    m.set(key, `${url}|${ratio}`);
    canvas.width = canvas.height = 0;
    return { url, ratio };
  });
}

export async function pageCount(file: Blob) {
  return (await docFor(file)).numPages;
}

export async function pageSizes(file: Blob) {
  const doc = await docFor(file);
  const out: { w: number; h: number }[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const v = (await doc.getPage(i)).getViewport({ scale: 1 });
    out.push({ w: v.width, h: v.height });
  }
  return out;
}
