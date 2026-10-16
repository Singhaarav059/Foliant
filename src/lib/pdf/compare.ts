"use client";

import { diffWordsWithSpace, type Change } from "diff";
import { closePdf, openPdf, renderPage } from "./common";
import { documentText, plainText } from "./text";

export type PageDiff = { page: number; changes: Change[]; added: number; removed: number };

export async function textDiff(a: File, b: File): Promise<PageDiff[]> {
  const [da, db] = await Promise.all([openPdf(await a.arrayBuffer()), openPdf(await b.arrayBuffer())]);
  const [ta, tb] = await Promise.all([documentText(da), documentText(db)]);
  await Promise.all([closePdf(da), closePdf(db)]);
  const pages = Math.max(ta.length, tb.length);
  const out: PageDiff[] = [];
  for (let i = 0; i < pages; i++) {
    const changes = diffWordsWithSpace(ta[i] ? plainText(ta[i]) : "", tb[i] ? plainText(tb[i]) : "");
    const added = changes.filter((c) => c.added).reduce((s, c) => s + c.value.trim().split(/\s+/).filter(Boolean).length, 0);
    const removed = changes.filter((c) => c.removed).reduce((s, c) => s + c.value.trim().split(/\s+/).filter(Boolean).length, 0);
    out.push({ page: i, changes, added, removed });
  }
  return out;
}

// Original in red, revised in blue; unchanged ink overlaps as dark grey.
export async function visualOverlay(a: File, b: File, pageIndex: number, width: number) {
  const [da, db] = await Promise.all([openPdf(await a.arrayBuffer()), openPdf(await b.arrayBuffer())]);
  try {
    const get = async (d: typeof da) => {
      if (pageIndex >= d.numPages) return null;
      const page = await d.getPage(pageIndex + 1);
      const v = page.getViewport({ scale: 1 });
      return renderPage(page, width / v.width);
    };
    const [ca, cb] = await Promise.all([get(da), get(db)]);
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
    return { canvas: out, changed, pages: Math.max(da.numPages, db.numPages) };
  } finally {
    await Promise.all([closePdf(da), closePdf(db)]);
  }
}
