"use client";

import { PDFDocument, degrees, PDFName, PDFArray, PDFHexString, PDFNumber } from "pdf-lib";
import { baseName, bytesOf, parseRanges, pdfBlob, type Output, type Progress } from "./common";

export async function loadPdf(file: Blob, name = "file.pdf") {
  try {
    return await PDFDocument.load(await bytesOf(file), { updateMetadata: false });
  } catch (e) {
    if (String(e).includes("encrypted")) throw new EncryptedError(name);
    throw e;
  }
}

export class EncryptedError extends Error {
  code = "encrypted";
  constructor(public fileName: string) {
    super(`${fileName} is encrypted`);
  }
}

async function save(doc: PDFDocument) {
  return pdfBlob(await doc.save({ useObjectStreams: true }));
}

export async function merge(files: File[], opts: { bookmarks?: boolean }, progress?: Progress): Promise<Output[]> {
  const out = await PDFDocument.create();
  const starts: { title: string; page: number }[] = [];
  for (let i = 0; i < files.length; i++) {
    const src = await loadPdf(files[i], files[i].name);
    starts.push({ title: baseName(files[i].name), page: out.getPageCount() });
    const pages = await out.copyPages(src, src.getPageIndices());
    pages.forEach((p) => out.addPage(p));
    progress?.(i + 1, files.length);
  }
  if (opts.bookmarks) addOutline(out, starts);
  return [{ name: `${baseName(files[0].name)}-merged.pdf`, blob: await save(out) }];
}

// A flat outline: one bookmark per entry, pointing at its first page.
export function addOutline(doc: PDFDocument, entries: { title: string; page: number }[]) {
  if (!entries.length) return;
  const ctx = doc.context;
  const outlineRef = ctx.nextRef();
  const refs = entries.map(() => ctx.nextRef());
  const pages = doc.getPages();
  entries.forEach((e, i) => {
    const dest = PDFArray.withContext(ctx);
    dest.push(pages[Math.min(e.page, pages.length - 1)].ref);
    dest.push(PDFName.of("XYZ"));
    dest.push(ctx.obj(null));
    dest.push(ctx.obj(null));
    dest.push(ctx.obj(null));
    const item: Record<string, unknown> = {
      Title: PDFHexString.fromText(e.title),
      Parent: outlineRef,
      Dest: dest,
    };
    if (i > 0) item.Prev = refs[i - 1];
    if (i < refs.length - 1) item.Next = refs[i + 1];
    ctx.assign(refs[i], ctx.obj(item as never));
  });
  ctx.assign(
    outlineRef,
    ctx.obj({ Type: "Outlines", First: refs[0], Last: refs[refs.length - 1], Count: PDFNumber.of(refs.length) } as never),
  );
  doc.catalog.set(PDFName.of("Outlines"), outlineRef);
  doc.catalog.set(PDFName.of("PageMode"), PDFName.of("UseOutlines"));
}

async function subset(src: PDFDocument, indices: number[]) {
  const out = await PDFDocument.create();
  const pages = await out.copyPages(src, indices);
  pages.forEach((p) => out.addPage(p));
  return out;
}

export async function split(
  file: File,
  opts: { splitMode: string; ranges: string; every: number; maxMb: number; mergeRanges: boolean },
  progress?: Progress,
): Promise<Output[]> {
  const src = await loadPdf(file, file.name);
  const total = src.getPageCount();
  const stem = baseName(file.name);
  let groups: number[][];

  if (opts.splitMode === "every") {
    const n = Math.max(1, Math.floor(opts.every));
    groups = [];
    for (let i = 0; i < total; i += n) groups.push(Array.from({ length: Math.min(n, total - i) }, (_, k) => i + k));
  } else if (opts.splitMode === "size") {
    // Grow each part page by page until the next page would push it over the limit.
    const limit = opts.maxMb * 1024 * 1024;
    groups = [];
    let current: number[] = [];
    for (let i = 0; i < total; i++) {
      const trial = await (await subset(src, [...current, i])).save({ useObjectStreams: true });
      if (trial.byteLength > limit && current.length) {
        groups.push(current);
        current = [i];
      } else current.push(i);
      progress?.(i + 1, total * 2);
    }
    if (current.length) groups.push(current);
  } else {
    groups = parseRanges(opts.ranges, total);
    if (!groups.length) throw new Error("No valid page ranges");
  }

  if (opts.splitMode === "ranges" && opts.mergeRanges) {
    return [{ name: `${stem}-pages.pdf`, blob: await save(await subset(src, groups.flat())) }];
  }
  const outputs: Output[] = [];
  for (let g = 0; g < groups.length; g++) {
    const pages = groups[g];
    const label = pages.length === 1 ? `${pages[0] + 1}` : `${pages[0] + 1}-${pages[pages.length - 1] + 1}`;
    outputs.push({ name: `${stem}-${label}.pdf`, blob: await save(await subset(src, pages)) });
    progress?.(g + 1, groups.length);
  }
  return outputs;
}

// One entry per output page. `file` indexes the input list; `blank` inserts an empty page.
export type PagePlan = { file: number; page: number; rotate: number; blank?: boolean }[];

export async function buildFromPlan(files: File[], plan: PagePlan): Promise<Blob> {
  const docs = await Promise.all(files.map((f) => loadPdf(f, f.name)));
  const out = await PDFDocument.create();
  for (const item of plan) {
    if (item.blank) {
      const ref = docs[item.file]?.getPage(Math.max(0, item.page));
      const size = ref ? ref.getSize() : { width: 595.28, height: 841.89 };
      out.addPage([size.width, size.height]).setRotation(degrees(item.rotate));
      continue;
    }
    const [copied] = await out.copyPages(docs[item.file], [item.page]);
    const base = copied.getRotation().angle;
    copied.setRotation(degrees((((base + item.rotate) % 360) + 360) % 360));
    out.addPage(copied);
  }
  return save(out);
}

export async function extractSeparate(file: File, pages: number[]): Promise<Output[]> {
  const src = await loadPdf(file, file.name);
  const stem = baseName(file.name);
  const outputs: Output[] = [];
  for (const p of pages) outputs.push({ name: `${stem}-page-${p + 1}.pdf`, blob: await save(await subset(src, [p])) });
  return outputs;
}

export async function rotateAll(file: File, angle: number): Promise<Output[]> {
  const doc = await loadPdf(file, file.name);
  for (const p of doc.getPages()) p.setRotation(degrees((p.getRotation().angle + angle) % 360));
  return [{ name: `${baseName(file.name)}-rotated.pdf`, blob: await save(doc) }];
}

