"use client";

import {
  PDFDocument, PDFPage, PDFPageLeaf, PDFDict, PDFStream, PDFRawStream, PDFRef, PDFNull, degrees, PDFName, PDFArray, PDFHexString, PDFNumber, PDFString,
  decodePDFRawStream, type PDFObject,
} from "pdf-lib";
import { baseName, bytesOf, parseRanges, pdfBlob, type Output, type Progress } from "./common";
import { PdfError } from "./errors";
import { openForEdit, shownRotation } from "./open";
import { prepareQpdf } from "./qpdf";

// Opens a file as readers do (see open.ts). Throws a PdfError: encrypted
// only when it needs an open password, damaged, not_pdf or no_pages.
export async function loadPdf(file: Blob, name = "file.pdf") {
  return (await openForEdit(await bytesOf(file), name)).doc;
}

// The same, with a note for the outputs when the file's owner-password
// restrictions were left behind.
async function loadNoting(file: File) {
  const { doc, decrypted } = await openForEdit(await bytesOf(file), file.name);
  return { doc, note: (outputs: Output[]) => noted(outputs, decrypted) };
}
const noted = (outputs: Output[], decrypted: boolean) =>
  decrypted && outputs[0] && !outputs[0].note ? [{ ...outputs[0], note: "unrestricted" }, ...outputs.slice(1)] : outputs;

// The same as PdfError("encrypted"), for callers that throw it by name.
export class EncryptedError extends PdfError {
  constructor(fileName: string) {
    super("encrypted", fileName);
  }
}

async function save(doc: PDFDocument) {
  return pdfBlob(await doc.save({ useObjectStreams: true, addDefaultPage: false }));
}

const N = (n: string) => PDFName.of(n);

// The pages each annotation sits on (one, unless a file shares them) and the
// form fields, per source document. A field's name is optional, so its keys
// can't tell a bare { Kids } parent from any other dict: a field is whatever
// sits above a widget or in the form's field tree. Sources are only read
// while pages are copied from them.
const sources = new WeakMap<PDFDocument, { annotPage: Map<PDFRef, PDFRef[]>; fields: Set<PDFDict> }>();
function indexSource(src: PDFDocument) {
  let index = sources.get(src);
  if (index) return index;
  const annotPage = new Map<PDFRef, PDFRef[]>();
  const fields = new Set<PDFDict>();
  const dict = (obj: PDFObject | undefined) => {
    const found = obj && src.context.lookup(obj);
    return found instanceof PDFDict ? found : undefined;
  };
  for (const page of src.getPages()) {
    for (const a of page.node.lookupMaybe(N("Annots"), PDFArray)?.asArray() ?? []) {
      if (!(a instanceof PDFRef)) continue;
      annotPage.set(a, [...(annotPage.get(a) ?? []), page.ref]);
      const widget = dict(a);
      if (widget?.get(N("Subtype")) !== N("Widget")) continue;
      const chain = new Set<PDFDict>();
      for (let f = dict(widget.get(N("Parent"))); f && !chain.has(f); f = dict(f.get(N("Parent")))) chain.add(f);
      chain.forEach((f) => fields.add(f));
    }
  }
  const tree = [...(src.catalog.lookupMaybe(N("AcroForm"), PDFDict)?.lookupMaybe(N("Fields"), PDFArray)?.asArray() ?? [])];
  while (tree.length) {
    const f = dict(tree.pop());
    if (!f || fields.has(f)) continue;
    fields.add(f);
    tree.push(...(f.lookupMaybe(N("Kids"), PDFArray)?.asArray() ?? []));
  }
  index = { annotPage, fields };
  sources.set(src, index);
  return index;
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
// function takes one page (again for a duplicate, which gets annotations of
// its own) for the caller to add.
export function pageCopier(src: PDFDocument, dest: PDFDocument, keep: Iterable<number>) {
  const ctx = dest.context;
  const pages = src.getPages();
  const allPages = new Set(pages.map((p) => p.ref));
  const copies = new Map<PDFRef, PDFRef>();
  for (const i of keep) if (!copies.has(pages[i].ref)) copies.set(pages[i].ref, ctx.nextRef());
  const placed = new Set<PDFRef>();
  const { annotPage, fields } = indexSource(src);
  const done = new Map<PDFRef, PDFObject>();
  // While a duplicate is copied: its page and the annotations on it, which
  // get copies of their own instead of the first copy's.
  let own: { page: PDFRef; refs: Map<PDFRef, PDFObject> } | undefined;

  const isPage = (ref: PDFRef, obj: PDFObject | undefined) => {
    if (allPages.has(ref)) return true;
    const type = obj instanceof PDFDict ? obj.get(N("Type")) : undefined;
    return type === N("Page") || type === N("Pages") || type === N("Catalog");
  };
  const outside = (ref: PDFRef) => !!annotPage.get(ref)?.every((page) => !copies.has(page));
  const isField = (obj: PDFObject | undefined) =>
    obj instanceof PDFDict && (fields.has(obj) || obj.has(N("T")) || obj.has(N("FT")) || obj.has(N("Parent")));
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

  // Direct objects are copied each time they're reached; indirect ones once.
  const copy = (obj: PDFObject): PDFObject => {
    if (obj instanceof PDFRef) return copyRef(obj);
    if (obj instanceof PDFStream) {
      const out = obj.clone(ctx);
      for (const [k, v] of obj.dict.entries()) out.dict.set(k, copy(v));
      return out;
    }
    if (obj instanceof PDFDict) {
      const out = obj.clone(ctx);
      // A field's kids are cut to those still kept. A parent with no name
      // and no place in the form is known by its kids.
      const kids = src.context.lookup(obj.get(N("Kids")));
      const field = kids instanceof PDFArray && (isField(obj) || kids.asArray().some((k) => isField(src.context.lookup(k))));
      for (const [k, v] of obj.entries()) {
        out.set(k, field && k === N("Kids") ? ctx.obj(kids.asArray().filter((kid) => fieldKept(kid)).map(copy)) : copy(v));
      }
      return out;
    }
    if (obj instanceof PDFArray) {
      const out = obj.clone(ctx);
      for (let i = 0; i < obj.size(); i++) out.set(i, copy(obj.get(i)));
      return out;
    }
    return obj.clone(ctx);
  };
  const copyRef = (ref: PDFRef): PDFObject => {
    const cache = own && (ref === own.page || annotPage.get(ref)?.includes(own.page)) ? own.refs : done;
    const seen = cache.get(ref);
    if (seen) return seen;
    const target = src.context.lookup(ref);
    if (isPage(ref, target)) return copies.get(ref) ?? PDFNull;
    if (target === undefined || outside(ref)) return PDFNull;
    const out = ctx.nextRef();
    cache.set(ref, out);
    ctx.assign(out, copy(target));
    return out;
  };

  const take = (index: number): PDFPage => {
    const original = pages[index];
    const leaf = original.node.clone(src.context) as PDFPageLeaf;
    // Inherited size, resources and rotation move onto the page itself.
    for (const key of PDFPageLeaf.InheritableEntries) {
      const value = original.node.getInheritableAttribute(N(key));
      if (!leaf.get(N(key)) && value) leaf.set(N(key), value);
    }
    leaf.delete(N("Parent"));
    const resources = ownResources(src, leaf, original.node);
    if (resources) leaf.set(N("Resources"), resources);
    const annots = leaf.lookupMaybe(N("Annots"), PDFArray);
    if (annots) {
      leaf.set(N("Annots"), src.context.obj(annots.asArray().filter((ref) => {
        const a = src.context.lookup(ref);
        if (!(a instanceof PDFDict) || a.get(N("Subtype")) !== N("Link")) return true;
        const target = linkTarget(a);
        return !(target instanceof PDFRef && isPage(target, src.context.lookup(target)) && !copies.has(target));
      })));
    }
    const first = copies.get(original.ref)!;
    const ref = placed.has(first) ? ctx.nextRef() : first;
    placed.add(first);
    own = ref === first ? undefined : { page: original.ref, refs: new Map([[original.ref, ref]]) };
    const node = copy(leaf) as PDFPageLeaf;
    own = undefined;
    ctx.assign(ref, node);
    return PDFPage.of(node, ref, dest);
  };
  // Any other object, by the same rules (a link to a page left out is cut),
  // and the copy an object already has.
  return Object.assign(take, { object: copy, copied: (ref: PDFRef) => done.get(ref) });
}

// The resources a page draws with. Pages often share one /Resources
// dictionary that names every page's images and fonts; copied as it is, a
// one-page part would carry them all. A page uses a resource only by naming
// it in its content, so the names its content mentions (anywhere: an
// over-count only keeps a little more) are the ones kept. Nothing is cut when
// the content can't be decoded, or when something it draws has no resources
// of its own and so borrows the page's: a form, a Type 3 font's glyphs or a
// tiling pattern (ISO 32000-1, 8.10.1, 9.6.5, 8.7.3.3).
const NAMED = ["XObject", "Font", "ExtGState", "Pattern", "Shading", "ColorSpace", "Properties"];
function ownResources(src: PDFDocument, leaf: PDFPageLeaf, page: PDFPageLeaf): PDFDict | undefined {
  const ctx = src.context;
  const resources = ctx.lookup(leaf.get(N("Resources")));
  if (!(resources instanceof PDFDict)) return undefined;
  if (!namesOf.has(page)) namesOf.set(page, contentNames(src, page) ?? null);
  const used = namesOf.get(page);
  if (!used) return undefined;
  const borrows = (category: string, own: (dict: PDFDict) => boolean) => {
    for (const [key, value] of resources.lookupMaybe(N(category), PDFDict)?.entries() ?? []) {
      const x = ctx.lookup(value);
      const dict = x instanceof PDFStream ? x.dict : x instanceof PDFDict ? x : undefined;
      if (dict && used.has(key.decodeText()) && own(dict) && !dict.has(N("Resources"))) return true;
    }
    return false;
  };
  if (
    borrows("XObject", (d) => d.get(N("Subtype")) === N("Form")) ||
    borrows("Font", (d) => d.get(N("Subtype")) === N("Type3")) ||
    borrows("Pattern", (d) => d.lookupMaybe(N("PatternType"), PDFNumber)?.asNumber() === 1)
  ) return undefined;
  const out = resources.clone(ctx);
  for (const category of NAMED) {
    const sub = resources.lookupMaybe(N(category), PDFDict);
    if (!sub) continue;
    const kept = ctx.obj({}) as PDFDict;
    for (const [key, value] of sub.entries()) if (used.has(key.decodeText())) kept.set(key, value);
    out.set(N(category), kept);
  }
  return out;
}

// Split by size copies each page again for every trial part.
const namesOf = new WeakMap<PDFPageLeaf, Set<string> | null>();

// Every name (/Im1, /F2 …) in a page's content streams, decoded; undefined
// when a stream can't be decoded.
function contentNames(src: PDFDocument, leaf: PDFPageLeaf): Set<string> | undefined {
  const ctx = src.context;
  const contents = ctx.lookup(leaf.get(N("Contents")));
  const streams = contents instanceof PDFArray ? contents.asArray().map((c) => ctx.lookup(c)) : contents ? [contents] : [];
  const names = new Set<string>();
  for (const s of streams) {
    if (!(s instanceof PDFStream)) return undefined;
    let data: Uint8Array;
    try {
      data = s instanceof PDFRawStream ? decodePDFRawStream(s).decode() : s.getContents();
    } catch {
      return undefined;
    }
    const text = new TextDecoder("latin1").decode(data);
    for (const m of text.matchAll(/\/([^\s/()<>[\]{}%]*)/g)) names.add(m[1].replace(/#([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))));
  }
  return names;
}

export async function merge(files: File[], opts: { bookmarks?: boolean }, progress?: Progress): Promise<Output[]> {
  const out = await PDFDocument.create();
  const sources: Source[] = [];
  let decrypted = false;
  for (let i = 0; i < files.length; i++) {
    const opened = await openForEdit(await bytesOf(files[i]), files[i].name);
    const src = opened.doc;
    decrypted ||= opened.decrypted;
    const start = out.getPageCount();
    const take = pageCopier(src, out, src.getPageIndices());
    for (const p of src.getPageIndices()) out.addPage(take(p));
    sources.push({ doc: src, take, title: baseName(files[i].name), first: start, pageAt: (p) => start + p });
    progress?.(i + 1, files.length);
  }
  carryOver(out, sources, !!opts.bookmarks);
  return noted([{ name: `${baseName(files[0].name)}-merged.pdf`, blob: await save(out) }], decrypted);
}

// ── What a document carries beyond its pages: form fields, attached files
// and bookmarks. Pages are copied first; each source then brings these
// along, pointing at its pages' copies.
type Source = {
  doc: PDFDocument;
  take: ReturnType<typeof pageCopier>;
  title: string;
  // The output page of a source page (where it first appears), if it was kept.
  pageAt: (index: number) => number | undefined;
  // The output page the file's own bookmark points at.
  first: number;
};

// `fileBookmarks`: one bookmark per source, its own bookmarks under it.
function carryOver(out: PDFDocument, sources: Source[], fileBookmarks: boolean) {
  carryForm(out, sources);
  carryAttachments(out, sources);
  const items = sources.flatMap((s): OutlineItem[] => {
    const own = outlineOf(s);
    return fileBookmarks ? [{ title: s.title, page: s.first, view: [], children: own, open: false }] : own;
  });
  writeOutline(out, items);
}

const textOf = (o: PDFObject | undefined) => (o instanceof PDFString || o instanceof PDFHexString ? o.decodeText() : undefined);

// One form of every source's fields that still have a widget on a kept page.
// A top-level name that's taken already gets a number ("total_2"), so the
// fields of a file merged with itself stay apart instead of sharing values.
// XFA can't be combined; the AcroForm fields every reader fills stay.
function carryForm(out: PDFDocument, sources: Source[]) {
  const ctx = out.context;
  const fields: PDFRef[] = [];
  const names = new Set<string>();
  const fonts = new Map<PDFName, PDFObject>();
  let da: PDFObject | undefined;
  let needAppearances = false;
  for (const s of sources) {
    const form = s.doc.catalog.lookupMaybe(N("AcroForm"), PDFDict);
    if (!form) continue;
    for (const f of form.lookupMaybe(N("Fields"), PDFArray)?.asArray() ?? []) {
      const copy = f instanceof PDFRef ? s.take.copied(f) : undefined;
      const dict = copy instanceof PDFRef ? ctx.lookup(copy) : undefined;
      if (!(copy instanceof PDFRef) || !(dict instanceof PDFDict)) continue;
      const name = textOf(dict.lookup(N("T")));
      if (name !== undefined) {
        let unique = name;
        for (let k = 2; names.has(unique); k++) unique = `${name}_${k}`;
        if (unique !== name) dict.set(N("T"), PDFHexString.fromText(unique));
        names.add(unique);
      }
      fields.push(copy);
    }
    da ??= form.get(N("DA"));
    needAppearances ||= form.get(N("NeedAppearances")) === ctx.obj(true);
    const dr = form.lookupMaybe(N("DR"), PDFDict)?.lookupMaybe(N("Font"), PDFDict);
    for (const [key, value] of dr?.entries() ?? []) if (!fonts.has(key)) fonts.set(key, s.take.object(value));
  }
  if (!fields.length) return;
  const acro = ctx.obj({}) as PDFDict;
  acro.set(N("Fields"), ctx.obj(fields));
  if (da) acro.set(N("DA"), da.clone(ctx));
  if (fonts.size) {
    const font = ctx.obj({}) as PDFDict;
    for (const [key, value] of fonts) font.set(key, value);
    acro.set(N("DR"), ctx.obj({ Font: font }));
  }
  if (needAppearances) acro.set(N("NeedAppearances"), ctx.obj(true));
  out.catalog.set(N("AcroForm"), ctx.register(acro));
}

// The entries of a name tree (attached files, named destinations).
function nameTree(doc: PDFDocument, root: PDFObject | undefined) {
  const entries: [PDFString | PDFHexString, PDFObject][] = [];
  const seen = new Set<PDFDict>();
  const visit = (o: PDFObject | undefined) => {
    const node = o && doc.context.lookup(o);
    if (!(node instanceof PDFDict) || seen.has(node)) return;
    seen.add(node);
    const names = node.lookupMaybe(N("Names"), PDFArray)?.asArray() ?? [];
    for (let i = 0; i + 1 < names.length; i += 2) {
      const key = doc.context.lookup(names[i]);
      if (key instanceof PDFString || key instanceof PDFHexString) entries.push([key, names[i + 1]]);
    }
    for (const kid of node.lookupMaybe(N("Kids"), PDFArray)?.asArray() ?? []) visit(kid);
  };
  visit(root);
  return entries;
}

// Every source's attached files; a name that's taken gets a number ("data (2).csv").
function carryAttachments(out: PDFDocument, sources: Source[]) {
  const ctx = out.context;
  const files: [string, PDFObject][] = [];
  const names = new Set<string>();
  for (const s of sources) {
    const tree = s.doc.catalog.lookupMaybe(N("Names"), PDFDict)?.get(N("EmbeddedFiles"));
    for (const [key, value] of nameTree(s.doc, tree)) {
      const name = key.decodeText();
      const dot = name.lastIndexOf(".");
      const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
      let unique = name;
      for (let k = 2; names.has(unique); k++) unique = `${stem} (${k})${ext}`;
      names.add(unique);
      files.push([unique, s.take.object(value)]);
    }
  }
  if (!files.length) return;
  files.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const list = files.flatMap(([name, value]) => [PDFHexString.fromText(name), value]);
  out.catalog.set(N("Names"), ctx.obj({ EmbeddedFiles: ctx.register(ctx.obj({ Names: list })) }));
}

type OutlineItem = {
  title: string;
  // An output page, and how to show it (the rest of the destination array).
  page?: number;
  view: PDFObject[];
  // Another action (a web link), when there's no page.
  action?: PDFObject;
  children: OutlineItem[];
  open: boolean;
};

// A source's bookmarks, pointing at its pages' copies. One for a page that
// was left out goes, unless bookmarks under it stay. Bookmarks nested deeper
// than MAX_OUTLINE_DEPTH are left out: reading and writing them recurses
// once per level, and no reader's panel shows that many levels anyway.
const MAX_OUTLINE_DEPTH = 256;
function outlineOf(s: Source): OutlineItem[] {
  const { doc } = s;
  const ctx = doc.context;
  const index = new Map(doc.getPages().map((p, i) => [p.ref, i] as const));
  const names = doc.catalog.lookupMaybe(N("Names"), PDFDict);
  let dests: Map<string, PDFObject> | undefined;
  // A destination: an array, or a name to look up (old style in /Dests,
  // new style in the Dests name tree), either possibly wrapped in { D }.
  const destOf = (o: PDFObject | undefined, depth = 0): PDFArray | undefined => {
    const d = o && ctx.lookup(o);
    if (depth > 3 || !d) return undefined;
    if (d instanceof PDFArray) return d;
    if (d instanceof PDFDict) return destOf(d.get(N("D")), depth + 1);
    if (d instanceof PDFName) return destOf(doc.catalog.lookupMaybe(N("Dests"), PDFDict)?.get(d), depth + 1);
    const key = textOf(d);
    if (key === undefined) return undefined;
    dests ??= new Map(nameTree(doc, names?.get(N("Dests"))).map(([k, v]) => [k.decodeText(), v] as const));
    return destOf(dests.get(key), depth + 1);
  };
  const seen = new Set<PDFDict>();
  const walk = (first: PDFObject | undefined, depth = 0): OutlineItem[] => {
    const items: OutlineItem[] = [];
    if (depth >= MAX_OUTLINE_DEPTH) return items;
    for (let o = first && ctx.lookup(first); o instanceof PDFDict && !seen.has(o); o = ctx.lookup(o.get(N("Next")) ?? PDFNull)) {
      seen.add(o);
      const action = o.lookupMaybe(N("A"), PDFDict);
      const goTo = action?.get(N("S")) === N("GoTo");
      const dest = destOf(o.get(N("Dest")) ?? (goTo ? action?.get(N("D")) : undefined));
      const target = dest?.get(0);
      const page = target instanceof PDFRef && index.has(target) ? s.pageAt(index.get(target)!) : undefined;
      const children = walk(o.get(N("First")), depth + 1);
      const other = !goTo && action && !o.has(N("Dest")) ? s.take.object(action) : undefined;
      if (page === undefined && !other && !children.length) continue;
      const count = o.lookupMaybe(N("Count"), PDFNumber)?.asNumber() ?? 0;
      items.push({
        title: textOf(o.lookup(N("Title"))) ?? "",
        page,
        view: page === undefined ? [] : (dest?.asArray().slice(1) ?? []).map((v) => s.take.object(v)),
        action: page === undefined ? other : undefined,
        children,
        open: count > 0,
      });
    }
    return items;
  };
  return walk(doc.catalog.lookupMaybe(N("Outlines"), PDFDict)?.get(N("First")));
}

// Writes bookmarks as the document's outline. A closed one's count is negative.
function writeOutline(doc: PDFDocument, items: OutlineItem[]) {
  if (!items.length) return;
  const ctx = doc.context;
  const pages = doc.getPages();
  const root = ctx.nextRef();
  const write = (list: OutlineItem[], parent: PDFRef) => {
    const refs = list.map(() => ctx.nextRef());
    let visible = 0;
    list.forEach((it, i) => {
      const item = ctx.obj({}) as PDFDict;
      item.set(N("Title"), PDFHexString.fromText(it.title));
      item.set(N("Parent"), parent);
      if (it.page !== undefined) {
        const view = it.view.length ? it.view : [N("XYZ"), PDFNull, PDFNull, PDFNull];
        item.set(N("Dest"), ctx.obj([pages[Math.min(it.page, pages.length - 1)].ref, ...view]));
      } else if (it.action) item.set(N("A"), it.action);
      if (i > 0) item.set(N("Prev"), refs[i - 1]);
      if (i < refs.length - 1) item.set(N("Next"), refs[i + 1]);
      visible++;
      if (it.children.length) {
        const sub = write(it.children, refs[i]);
        item.set(N("First"), sub.first);
        item.set(N("Last"), sub.last);
        item.set(N("Count"), PDFNumber.of(it.open ? sub.visible : -sub.visible));
        if (it.open) visible += sub.visible;
      }
      ctx.assign(refs[i], item);
    });
    return { first: refs[0], last: refs[refs.length - 1], visible };
  };
  const top = write(items, root);
  ctx.assign(root, ctx.obj({ Type: "Outlines", First: top.first, Last: top.last, Count: PDFNumber.of(top.visible) } as never));
  doc.catalog.set(N("Outlines"), root);
  doc.catalog.set(N("PageMode"), N("UseOutlines"));
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
  const { doc: src, note } = await loadNoting(file);
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
    if (!groups.length) throw new PdfError("bad_ranges", file.name);
  }

  if (opts.splitMode === "ranges" && opts.mergeRanges) {
    return note([{ name: `${stem}-pages.pdf`, blob: await save(await subset(src, groups.flat())) }]);
  }
  const outputs: Output[] = [];
  for (let g = 0; g < groups.length; g++) {
    const pages = groups[g];
    const label = pages.length === 1 ? `${pages[0] + 1}` : `${pages[0] + 1}-${pages[pages.length - 1] + 1}`;
    outputs.push({ name: `${stem}-${label}.pdf`, blob: await save(await subset(src, pages)) });
    progress?.(g + 1, groups.length);
  }
  return note(outputs);
}

// One entry per output page. `file` indexes the input list; `blank` inserts an empty page.
export type PagePlan = { file: number; page: number; rotate: number; blank?: boolean }[];

export async function buildFromPlan(files: File[], plan: PagePlan): Promise<Blob> {
  // One at a time: each opening runs qpdf over a copy of the file.
  const docs: PDFDocument[] = [];
  for (const f of files) docs.push(await loadPdf(f, f.name));
  const out = await PDFDocument.create();
  const takers = docs.map((doc, fi) => pageCopier(doc, out, plan.filter((p) => p.file === fi && !p.blank).map((p) => p.page)));
  // Where each source page first lands, for bookmarks.
  const at = new Map<string, number>();
  plan.forEach((item, i) => !item.blank && !at.has(`${item.file}:${item.page}`) && at.set(`${item.file}:${item.page}`, i));
  for (const item of plan) {
    if (item.blank) {
      const ref = docs[item.file]?.getPage(Math.max(0, item.page));
      const size = ref ? ref.getSize() : { width: 595.28, height: 841.89 };
      out.addPage([size.width, size.height]).setRotation(degrees(item.rotate));
      continue;
    }
    const copied = takers[item.file](item.page);
    const base = shownRotation(copied);
    copied.setRotation(degrees((((base + item.rotate) % 360) + 360) % 360));
    out.addPage(copied);
  }
  carryOver(out, docs.map((doc, fi) => ({ doc, take: takers[fi], title: baseName(files[fi].name), first: 0, pageAt: (p) => at.get(`${fi}:${p}`) })), false);
  return save(out);
}

export async function extractSeparate(file: File, pages: number[]): Promise<Output[]> {
  const { doc: src, note } = await loadNoting(file);
  const stem = baseName(file.name);
  const outputs: Output[] = [];
  for (const p of pages) outputs.push({ name: `${stem}-page-${p + 1}.pdf`, blob: await save(await subset(src, [p])) });
  return note(outputs);
}

export async function rotateAll(file: File, angle: number): Promise<Output[]> {
  const { doc, note } = await loadNoting(file);
  for (const p of doc.getPages()) p.setRotation(degrees((((shownRotation(p) + angle) % 360) + 360) % 360));
  return note([{ name: `${baseName(file.name)}-rotated.pdf`, blob: await save(doc) }]);
}

// Loads the code these tools run on, for src/lib/offline.ts.
export const prepare = () => prepareQpdf();
