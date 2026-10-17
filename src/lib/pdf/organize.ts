"use client";

import {
  PDFDocument, PDFPage, PDFPageLeaf, PDFDict, PDFStream, PDFRef, PDFNull, degrees, PDFName, PDFArray, PDFHexString, PDFNumber, type PDFObject,
} from "pdf-lib";
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

const N = (n: string) => PDFName.of(n);

// The pages each annotation sits on (one, unless a file shares them), per
// source document. Sources are only read while pages are copied from them.
const annotPages = new WeakMap<PDFDocument, Map<PDFRef, PDFRef[]>>();
function annotationsByPage(src: PDFDocument) {
  let map = annotPages.get(src);
  if (!map) {
    map = new Map();
    for (const page of src.getPages()) {
      for (const a of page.node.lookupMaybe(N("Annots"), PDFArray)?.asArray() ?? []) {
        if (a instanceof PDFRef) map.set(a, [...(map.get(a) ?? []), page.ref]);
      }
    }
    annotPages.set(src, map);
  }
  return map;
}

// Copies pages into another document without following links to other pages.
// pdf-lib's copyPages copies everything a page refers to, and a link refers to
// the page it points at, so a one-page extract of a linked book carried every
// page of the book as hidden content. Here a reference to a page in `keep`
// points at that page's copy; one to any other page is cut, and so are links
// to it, annotations that sit on it and form fields that only live there.
// Shared fonts and images are copied once per copier.
//
// `keep` lists every source page index the caller will take; the returned
// function takes one page (again for a duplicate) for the caller to add.
export function pageCopier(src: PDFDocument, dest: PDFDocument, keep: Iterable<number>) {
  const ctx = dest.context;
  const pages = src.getPages();
  const allPages = new Set(pages.map((p) => p.ref));
  const copies = new Map<PDFRef, PDFRef>();
  for (const i of keep) if (!copies.has(pages[i].ref)) copies.set(pages[i].ref, ctx.nextRef());
  const placed = new Set<PDFRef>();
  const annotPage = annotationsByPage(src);
  const done = new Map<PDFObject, PDFObject>();

  const isPage = (ref: PDFRef, obj: PDFObject | undefined) => {
    if (allPages.has(ref)) return true;
    const type = obj instanceof PDFDict ? obj.get(N("Type")) : undefined;
    return type === N("Page") || type === N("Pages") || type === N("Catalog");
  };
  const outside = (ref: PDFRef) => !!annotPage.get(ref)?.every((page) => !copies.has(page));
  // A field is kept while one of its widgets sits on a kept page.
  const fieldKept = (obj: PDFObject | undefined, seen = new Set<PDFObject>()): boolean => {
    if (!(obj instanceof PDFRef)) return obj instanceof PDFDict;
    if (seen.has(obj)) return false;
    seen.add(obj);
    if (annotPage.has(obj)) return !outside(obj);
    const kids = src.context.lookupMaybe(obj, PDFDict)?.lookupMaybe(N("Kids"), PDFArray);
    return !!kids?.asArray().some((k) => fieldKept(k, seen));
  };
  // The page a link jumps to, when it names one directly.
  const linkTarget = (annot: PDFDict) => {
    const action = annot.lookupMaybe(N("A"), PDFDict);
    const dest = annot.get(N("Dest")) ?? (action?.get(N("S")) === N("GoTo") ? action.get(N("D")) : undefined);
    const first = dest && src.context.lookup(dest);
    return first instanceof PDFArray ? first.get(0) : undefined;
  };

  const copy = (obj: PDFObject): PDFObject => {
    if (obj instanceof PDFRef) return copyRef(obj);
    const seen = done.get(obj);
    if (seen) return seen;
    if (obj instanceof PDFStream) {
      const out = obj.clone(ctx);
      done.set(obj, out);
      for (const [k, v] of obj.dict.entries()) out.dict.set(k, copy(v));
      return out;
    }
    if (obj instanceof PDFDict) {
      const out = obj.clone(ctx);
      done.set(obj, out);
      const field = obj.has(N("T")) || obj.has(N("FT")) || obj.has(N("Parent"));
      for (const [k, v] of obj.entries()) {
        const kids = field && k === N("Kids") ? src.context.lookup(v) : undefined;
        if (kids instanceof PDFArray) out.set(k, ctx.obj(kids.asArray().filter((kid) => fieldKept(kid)).map(copy)));
        else out.set(k, copy(v));
      }
      return out;
    }
    if (obj instanceof PDFArray) {
      const out = obj.clone(ctx);
      done.set(obj, out);
      for (let i = 0; i < obj.size(); i++) out.set(i, copy(obj.get(i)));
      return out;
    }
    return obj.clone(ctx);
  };
  const copyRef = (ref: PDFRef): PDFObject => {
    const seen = done.get(ref);
    if (seen) return seen;
    const target = src.context.lookup(ref);
    if (isPage(ref, target)) return copies.get(ref) ?? PDFNull;
    if (target === undefined || outside(ref)) return PDFNull;
    const out = ctx.nextRef();
    done.set(ref, out);
    ctx.assign(out, copy(target));
    return out;
  };

  return (index: number): PDFPage => {
    const original = pages[index];
    const leaf = original.node.clone(src.context) as PDFPageLeaf;
    // Inherited size, resources and rotation move onto the page itself.
    for (const key of PDFPageLeaf.InheritableEntries) {
      const value = original.node.getInheritableAttribute(N(key));
      if (!leaf.get(N(key)) && value) leaf.set(N(key), value);
    }
    leaf.delete(N("Parent"));
    const annots = leaf.lookupMaybe(N("Annots"), PDFArray);
    if (annots) {
      leaf.set(N("Annots"), src.context.obj(annots.asArray().filter((ref) => {
        const a = src.context.lookup(ref);
        if (!(a instanceof PDFDict) || a.get(N("Subtype")) !== N("Link")) return true;
        const target = linkTarget(a);
        return !(target instanceof PDFRef && isPage(target, src.context.lookup(target)) && !copies.has(target));
      })));
    }
    const node = copy(leaf) as PDFPageLeaf;
    let ref = copies.get(original.ref)!;
    if (placed.has(ref)) ref = ctx.nextRef();
    placed.add(ref);
    ctx.assign(ref, node);
    return PDFPage.of(node, ref, dest);
  };
}

export async function merge(files: File[], opts: { bookmarks?: boolean }, progress?: Progress): Promise<Output[]> {
  const out = await PDFDocument.create();
  const starts: { title: string; page: number }[] = [];
  for (let i = 0; i < files.length; i++) {
    const src = await loadPdf(files[i], files[i].name);
    starts.push({ title: baseName(files[i].name), page: out.getPageCount() });
    const take = pageCopier(src, out, src.getPageIndices());
    for (const p of src.getPageIndices()) out.addPage(take(p));
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
  const take = pageCopier(src, out, indices);
  for (const i of indices) out.addPage(take(i));
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
  const takers = docs.map((doc, fi) => pageCopier(doc, out, plan.filter((p) => p.file === fi && !p.blank).map((p) => p.page)));
  for (const item of plan) {
    if (item.blank) {
      const ref = docs[item.file]?.getPage(Math.max(0, item.page));
      const size = ref ? ref.getSize() : { width: 595.28, height: 841.89 };
      out.addPage([size.width, size.height]).setRotation(degrees(item.rotate));
      continue;
    }
    const copied = takers[item.file](item.page);
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

