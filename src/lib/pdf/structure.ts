"use client";

// Document structure tools (P2-09), written from the PDF specification
// (ISO 32000) on pdf-lib and the vendored qpdf:
//   metadata     the document information dictionary and XMP
//   bookmarks    an outline made from the headings, or none
//   flatten      form fields and annotations drawn into the page
//   attachments  files attached to the PDF: add, extract or remove
//   sanitize     scripts, attachments, links, metadata and hidden data out
//   web-optimize linearized ("fast web view"), so a browser shows page 1 first

import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNull, PDFNumber, PDFRawStream, PDFRef, PDFStream, PDFString, decodePDFRawStream } from "pdf-lib";
import { baseName, bytesOf, closePdf, openPdf, pdfBlob, type Output, type Progress } from "./common";
import { openForEdit } from "./open";
import { PdfError } from "./errors";
import { runQpdf } from "./qpdf";
import { blocks, bodySizeOf, documentText } from "./text";
import { nameTree, writeOutline, type OutlineItem } from "./organize";

const N = (s: string) => PDFName.of(s);
const text = (o: unknown) => (o instanceof PDFString || o instanceof PDFHexString ? o.decodeText() : undefined);
const xmlEscape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const save = async (doc: PDFDocument) => doc.save({ useObjectStreams: true, addDefaultPage: false, updateFieldAppearances: false });

// ── Metadata

export type MetaOptions = { mode: string; title: string; author: string; subject: string; keywords: string };
const INFO_KEYS = ["Title", "Author", "Subject", "Keywords", "Creator", "Producer", "CreationDate", "ModDate", "Trapped"];

// "edit": each field filled in replaces the file's, an empty one keeps it.
// The XMP is written again from the result, so readers that prefer XMP show
// the same; a PDF/A identification in the old one is kept. "clear": every property,
// the XMP and the per-page metadata go.
export async function editMetadata(file: File, o: MetaOptions): Promise<Output[]> {
  const { doc } = await openForEdit(await bytesOf(file), file.name);
  const ctx = doc.context;
  const info = ctx.lookup(ctx.trailerInfo.Info);
  const oldXmp = xmpOf(doc);
  if (o.mode === "clear") {
    if (info instanceof PDFDict) for (const k of info.keys()) info.delete(k);
    doc.catalog.delete(N("Metadata"));
    for (const page of doc.getPages()) for (const k of ["Metadata", "PieceInfo"]) page.node.delete(N(k));
    doc.catalog.delete(N("PieceInfo"));
  } else {
    if (o.title.trim()) doc.setTitle(o.title.trim());
    if (o.author.trim()) doc.setAuthor(o.author.trim());
    if (o.subject.trim()) doc.setSubject(o.subject.trim());
    if (o.keywords.trim()) doc.setKeywords(o.keywords.split(/[,;]/).map((k) => k.trim()).filter(Boolean));
    doc.setModificationDate(new Date());
    const id = oldXmp.match(/pdfaid:part\s*=\s*["'](\d)["']|<pdfaid:part>(\d)</);
    const conf = oldXmp.match(/pdfaid:conformance\s*=\s*["']([A-Za-z])["']|<pdfaid:conformance>([A-Za-z])</);
    writeXmp(doc, id ? `${id[1] ?? id[2]}${(conf?.[1] ?? conf?.[2] ?? "B").toUpperCase()}` : "");
  }
  return [{ name: `${baseName(file.name)}-metadata.pdf`, blob: pdfBlob(await save(doc)) }];
}

function xmpOf(doc: PDFDocument): string {
  const meta = doc.context.lookup(doc.catalog.get(N("Metadata")));
  if (!(meta instanceof PDFStream)) return "";
  try {
    return new TextDecoder().decode(meta instanceof PDFRawStream ? decodePDFRawStream(meta).decode() : meta.getContents());
  } catch {
    return "";
  }
}

// XMP saying what the information dictionary says, plus the PDF/A part and level when given.
function writeXmp(doc: PDFDocument, pdfa: string) {
  const iso = (d?: Date) => (d ? d.toISOString().replace(/\.\d{3}Z$/, "Z") : "");
  const title = doc.getTitle(), author = doc.getAuthor(), subject = doc.getSubject(), keywords = doc.getKeywords();
  const creator = doc.getCreator(), producer = doc.getProducer();
  const created = iso(doc.getCreationDate()), modified = iso(doc.getModificationDate());
  const xmp = `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
    xmlns:dc="http://purl.org/dc/elements/1.1/"
    xmlns:xmp="http://ns.adobe.com/xap/1.0/"
    xmlns:pdf="http://ns.adobe.com/pdf/1.3/"${pdfa ? `
    xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/"` : ""}>
   <dc:format>application/pdf</dc:format>${title ? `
   <dc:title><rdf:Alt><rdf:li xml:lang="x-default">${xmlEscape(title)}</rdf:li></rdf:Alt></dc:title>` : ""}${author ? `
   <dc:creator><rdf:Seq><rdf:li>${xmlEscape(author)}</rdf:li></rdf:Seq></dc:creator>` : ""}${subject ? `
   <dc:description><rdf:Alt><rdf:li xml:lang="x-default">${xmlEscape(subject)}</rdf:li></rdf:Alt></dc:description>` : ""}${keywords ? `
   <pdf:Keywords>${xmlEscape(keywords)}</pdf:Keywords>` : ""}${producer ? `
   <pdf:Producer>${xmlEscape(producer)}</pdf:Producer>` : ""}${creator ? `
   <xmp:CreatorTool>${xmlEscape(creator)}</xmp:CreatorTool>` : ""}${created ? `
   <xmp:CreateDate>${created}</xmp:CreateDate>` : ""}${modified ? `
   <xmp:ModifyDate>${modified}</xmp:ModifyDate>
   <xmp:MetadataDate>${modified}</xmp:MetadataDate>` : ""}${pdfa ? `
   <pdfaid:part>${pdfa[0]}</pdfaid:part>
   <pdfaid:conformance>${pdfa[1]}</pdfaid:conformance>` : ""}
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;
  const stream = doc.context.stream(new TextEncoder().encode(xmp), { Type: "Metadata", Subtype: "XML" });
  doc.catalog.set(N("Metadata"), doc.context.register(stream));
}

// The document properties, for showing what a file says about itself.
export async function readMetadata(file: Blob): Promise<Record<string, string>> {
  const doc = await PDFDocument.load(await bytesOf(file), { updateMetadata: false, ignoreEncryption: true, throwOnInvalidObject: false });
  const info = doc.context.lookup(doc.context.trailerInfo.Info);
  const out: Record<string, string> = {};
  if (info instanceof PDFDict) for (const k of INFO_KEYS) {
    const v = text(info.lookup(N(k)));
    if (v) out[k] = v;
  }
  return out;
}

// ── Bookmarks

// "auto": one bookmark per heading (text set larger or bolder than the body,
// see text.ts blocks), nested by heading level, at most `depth` levels,
// replacing the outline the file had. "remove": no outline at all.
export async function bookmarks(file: File, o: { mode: string; depth: number }, progress?: Progress): Promise<Output[]> {
  const { doc, bytes } = await openForEdit(await bytesOf(file), file.name);
  doc.catalog.delete(N("Outlines"));
  if (doc.catalog.get(N("PageMode")) === N("UseOutlines")) doc.catalog.delete(N("PageMode"));
  let count = 0;
  if (o.mode !== "remove") {
    const items = await headingOutline(bytes, Math.max(1, Math.min(6, o.depth || 3)), progress);
    count = countItems(items);
    writeOutline(doc, items);
  }
  return [{ name: `${baseName(file.name)}-bookmarks.pdf`, blob: pdfBlob(await save(doc)), note: o.mode === "remove" ? undefined : `bookmarks:${count}` }];
}

const countItems = (items: OutlineItem[]): number => items.reduce((n, i) => n + 1 + countItems(i.children), 0);

export async function headingOutline(bytes: Uint8Array, depth: number, progress?: Progress): Promise<OutlineItem[]> {
  const pdf = await openPdf(bytes);
  let pages;
  try {
    pages = await documentText(pdf, (i) => progress?.(i, pdf.numPages));
  } finally {
    await closePdf(pdf);
  }
  const body = bodySizeOf(pages);
  const root: OutlineItem[] = [];
  // The latest bookmark at each level, to nest the next one under.
  const stack: { level: number; item: OutlineItem }[] = [];
  pages.forEach((p, pi) => {
    for (const b of blocks(p.lines, body)) {
      if (b.kind !== "heading" || !b.level || b.level > depth) continue;
      const title = b.text.replace(/\s+/g, " ").trim().slice(0, 200);
      if (!/[\p{L}\p{N}]/u.test(title)) continue;
      // The heading's top, in PDF points from the bottom of the page.
      const top = p.height - b.lines[0].y + 2;
      const item: OutlineItem = { title, page: pi, view: [N("XYZ"), PDFNull, PDFNumber.of(Math.round(top)), PDFNull], children: [], open: b.level < 2 };
      while (stack.length && stack[stack.length - 1].level >= b.level) stack.pop();
      (stack.length ? stack[stack.length - 1].item.children : root).push(item);
      stack.push({ level: b.level, item });
    }
  });
  return root;
}

// ── Flatten

// qpdf draws form fields (with fresh appearances) and annotations into the
// page content; "forms" leaves other annotations as they are. An annotation
// with no appearance of its own (a note readers show as an icon) stays as it
// is. The form itself goes, so nothing is left to fill in.
export async function flatten(file: File, o: { flattenWhat: string }): Promise<Output[]> {
  const { bytes } = await openForEdit(await bytesOf(file), file.name);
  const which = o.flattenWhat === "forms" ? "screen" : "all";
  let { output } = await runQpdf(bytes, (i, out) => ["--generate-appearances", `--flatten-annotations=${which}`, "--object-streams=generate", i, out]);
  const doc = await PDFDocument.load(output, { updateMetadata: false });
  if (doc.catalog.has(N("AcroForm")) || (o.flattenWhat === "forms" && hasWidgets(doc))) {
    // Widgets that weren't printable stay as annotations under "screen": the form goes either way.
    for (const page of doc.getPages()) {
      const annots = page.node.lookupMaybe(N("Annots"), PDFArray);
      if (!annots) continue;
      const kept = annots.asArray().filter((r) => doc.context.lookup(r, PDFDict)?.get(N("Subtype")) !== N("Widget"));
      if (kept.length) page.node.set(N("Annots"), doc.context.obj(kept));
      else page.node.delete(N("Annots"));
    }
    doc.catalog.delete(N("AcroForm"));
    output = await save(doc);
  }
  return [{ name: `${baseName(file.name)}-flat.pdf`, blob: pdfBlob(output) }];
}

const hasWidgets = (doc: PDFDocument) =>
  doc.getPages().some((p) => (p.node.lookupMaybe(N("Annots"), PDFArray)?.asArray() ?? []).some((r) => doc.context.lookup(r, PDFDict)?.get(N("Subtype")) === N("Widget")));

// ── Attachments

// The files attached to a PDF: the document's list (EmbeddedFiles) and file
// attachment annotations on its pages.
export async function listAttachments(bytes: Uint8Array): Promise<{ name: string; data: Uint8Array }[]> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false, ignoreEncryption: true, throwOnInvalidObject: false });
  const out: { name: string; data: Uint8Array }[] = [];
  const read = (spec: unknown, fallback: string) => {
    const fs = doc.context.lookup(spec as PDFRef);
    if (!(fs instanceof PDFDict)) return;
    const ef = fs.lookupMaybe(N("EF"), PDFDict);
    const stream = ef && doc.context.lookup(ef.get(N("UF")) ?? ef.get(N("F")));
    if (!(stream instanceof PDFRawStream)) return;
    let data: Uint8Array;
    try {
      data = decodePDFRawStream(stream).decode();
    } catch {
      return;
    }
    const name = text(fs.lookup(N("UF"))) ?? text(fs.lookup(N("F"))) ?? fallback;
    out.push({ name: name.split(/[\\/]/).pop() || fallback, data });
  };
  const tree = doc.catalog.lookupMaybe(N("Names"), PDFDict)?.get(N("EmbeddedFiles"));
  for (const [key, value] of nameTree(doc, tree)) read(value, key.decodeText());
  for (const page of doc.getPages())
    for (const r of page.node.lookupMaybe(N("Annots"), PDFArray)?.asArray() ?? []) {
      const a = doc.context.lookup(r, PDFDict);
      if (a?.get(N("Subtype")) === N("FileAttachment")) read(a.get(N("FS")), "attachment");
    }
  return out;
}

const MIME: Record<string, string> = {
  pdf: "application/pdf", txt: "text/plain", csv: "text/csv", xml: "application/xml", json: "application/json", html: "text/html",
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation", odt: "application/vnd.oasis.opendocument.text",
  zip: "application/zip", md: "text/markdown",
};

// "add": the first PDF gets every other file attached ("extract" and "remove"
// work on each PDF). Extracting gives the attached files themselves.
export async function attachments(files: File[], o: { attachMode: string }, progress?: Progress): Promise<Output[]> {
  const pdfs = files.filter((f) => /\.pdf$/i.test(f.name));
  if (o.attachMode === "add") {
    const [target, ...rest] = pdfs.length ? [pdfs[0], ...files.filter((f) => f !== pdfs[0])] : files;
    const { doc } = await openForEdit(await bytesOf(target), target.name);
    for (const [i, f] of rest.entries()) {
      const ext = f.name.split(".").pop()?.toLowerCase() ?? "";
      await doc.attach(await bytesOf(f), f.name, { mimeType: MIME[ext] ?? (f.type || "application/octet-stream"), creationDate: new Date(f.lastModified || Date.now()), modificationDate: new Date(f.lastModified || Date.now()) });
      progress?.(i + 1, rest.length);
    }
    return [{ name: `${baseName(target.name)}-attached.pdf`, blob: pdfBlob(await save(doc)), note: `attached:${rest.length}` }];
  }
  const out: Output[] = [];
  for (const [i, f] of pdfs.entries()) {
    if (o.attachMode === "remove") {
      const { doc } = await openForEdit(await bytesOf(f), f.name);
      const names = doc.catalog.lookupMaybe(N("Names"), PDFDict);
      names?.delete(N("EmbeddedFiles"));
      doc.catalog.delete(N("AF"));
      for (const page of doc.getPages()) {
        const annots = page.node.lookupMaybe(N("Annots"), PDFArray);
        if (!annots) continue;
        const kept = annots.asArray().filter((r) => doc.context.lookup(r, PDFDict)?.get(N("Subtype")) !== N("FileAttachment"));
        if (kept.length) page.node.set(N("Annots"), doc.context.obj(kept));
        else page.node.delete(N("Annots"));
      }
      // qpdf leaves out the streams nothing refers to any more.
      const { output } = await runQpdf(await save(doc), (a, b) => ["--object-streams=generate", a, b]);
      out.push({ name: `${baseName(f.name)}-no-attachments.pdf`, blob: pdfBlob(output) });
    } else {
      const found = await listAttachments(await bytesOf(f));
      const used = new Set<string>();
      for (const a of found) {
        let name = a.name;
        for (let k = 2; used.has(name); k++) name = a.name.replace(/(\.[^.]+)?$/, (e) => ` (${k})${e}`);
        used.add(name);
        out.push({ name: pdfs.length > 1 ? `${baseName(f.name)}-${name}` : name, blob: new Blob([a.data as BlobPart], { type: MIME[name.split(".").pop()?.toLowerCase() ?? ""] ?? "application/octet-stream" }) });
      }
    }
    progress?.(i + 1, pdfs.length);
  }
  if (!out.length) throw new PdfError("no_attachments", pdfs[0]?.name ?? "");
  return out;
}

// ── Sanitize

export type SanitizeOptions = { scripts: boolean; files: boolean; links: boolean; metadata: boolean; forms: boolean };

// Takes out what can run, call out or carry hidden data: scripts and other
// actions (opening, closing, page and field actions, JavaScript), attached
// files, links to the web and other files, the metadata (properties, XMP,
// page metadata, editors' private data, thumbnails), and with `forms` the
// form fields too (drawn into the page first). Then qpdf rewrites the file
// from what pages still use, so nothing removed survives as a stray object.
export async function sanitize(file: File, o: SanitizeOptions): Promise<Output[]> {
  let { doc } = await openForEdit(await bytesOf(file), file.name);
  if (o.forms && (doc.catalog.has(N("AcroForm")) || hasWidgets(doc))) {
    const [flat] = await flatten(new File([await save(doc) as BlobPart], file.name), { flattenWhat: "forms" });
    doc = await PDFDocument.load(await bytesOf(flat.blob), { updateMetadata: false });
  }
  const ctx = doc.context;
  const removed = new Set<string>();
  const strip = (d: PDFDict | undefined, key: string, what: string) => {
    if (!d?.has(N(key))) return;
    d.delete(N(key));
    removed.add(what);
  };
  const ACTIONS = new Set(["JavaScript", "Launch", "SubmitForm", "ImportData", "ResetForm", "Sound", "Movie", "Rendition", "Hide", "SetOCGState", "GoTo3DView", "Trans"]);
  const OUT = new Set(["URI", "GoToR", "GoToE", "Launch", "SubmitForm", "ImportData"]);
  // An action is dropped when it runs something, or (with `links`) leaves the document.
  const drop = (a: PDFDict | undefined) => {
    const s = a?.get(N("S"));
    const name = s instanceof PDFName ? s.decodeText() : "";
    return (o.scripts && ACTIONS.has(name)) || (o.links && OUT.has(name));
  };
  const kind = (a: PDFDict) => (o.links && OUT.has(String(a.get(N("S"))).slice(1)) ? "links" : "scripts");
  if (o.scripts) {
    strip(doc.catalog, "AA", "scripts");
    strip(doc.catalog.lookupMaybe(N("Names"), PDFDict), "JavaScript", "scripts");
    strip(doc.catalog.lookupMaybe(N("AcroForm"), PDFDict), "XFA", "scripts");
  }
  const open = doc.catalog.lookup(N("OpenAction"));
  if (open instanceof PDFDict && drop(open)) strip(doc.catalog, "OpenAction", kind(open));
  for (const [, obj] of ctx.enumerateIndirectObjects()) {
    const d = obj instanceof PDFDict ? obj : undefined;
    if (!d) continue;
    if (o.scripts) strip(d, "AA", "scripts");
    const a = d.lookupMaybe(N("A"), PDFDict);
    if (a && drop(a)) strip(d, "A", kind(a));
    // A chain of actions: the next ones go the same way.
    const next = d.get(N("Next"));
    if (next && d.has(N("S"))) {
      const list = next instanceof PDFArray ? next.asArray() : [next];
      const kept = list.filter((r) => !drop(ctx.lookup(r) as PDFDict | undefined));
      if (kept.length !== list.length) {
        if (kept.length) d.set(N("Next"), ctx.obj(kept));
        else d.delete(N("Next"));
      }
    }
  }
  for (const page of doc.getPages()) {
    const annots = page.node.lookupMaybe(N("Annots"), PDFArray);
    if (annots) {
      const kept = annots.asArray().filter((r) => {
        const a = ctx.lookup(r, PDFDict);
        const sub = a?.get(N("Subtype"));
        if (o.files && sub === N("FileAttachment")) return !removed.add("files");
        if (o.links && sub === N("Link") && !a?.has(N("A")) && !a?.has(N("Dest"))) return !removed.add("links");
        if (o.scripts && (sub === N("Screen") || sub === N("Movie") || sub === N("Sound") || sub === N("RichMedia"))) return !removed.add("scripts");
        return true;
      });
      if (kept.length) page.node.set(N("Annots"), ctx.obj(kept));
      else page.node.delete(N("Annots"));
    }
    if (o.metadata) for (const k of ["Metadata", "PieceInfo", "Thumb"]) strip(page.node, k, "metadata");
  }
  if (o.files) {
    strip(doc.catalog.lookupMaybe(N("Names"), PDFDict), "EmbeddedFiles", "files");
    strip(doc.catalog, "AF", "files");
  }
  if (o.metadata) {
    const info = ctx.lookup(ctx.trailerInfo.Info);
    if (info instanceof PDFDict && info.keys().length) {
      for (const k of info.keys()) info.delete(k);
      removed.add("metadata");
    }
    for (const k of ["Metadata", "PieceInfo"]) strip(doc.catalog, k, "metadata");
  }
  const bytes = await doc.save({ useObjectStreams: false, addDefaultPage: false, updateFieldAppearances: false });
  const { output } = await runQpdf(bytes, (i, out) => ["--object-streams=generate", "--remove-unreferenced-resources=yes", i, out]);
  return [{ name: `${baseName(file.name)}-sanitized.pdf`, blob: pdfBlob(output), note: `sanitized:${[...removed].join(",")}` }];
}

// ── Web optimize

// Linearized ("fast web view"): the first page's objects come first, with a
// hint table, so a browser can show it before the rest has arrived.
export async function linearize(file: File): Promise<Output[]> {
  const { bytes } = await openForEdit(await bytesOf(file), file.name);
  const { output } = await runQpdf(bytes, (i, out) => ["--linearize", "--object-streams=generate", i, out]);
  return [{ name: `${baseName(file.name)}-web.pdf`, blob: pdfBlob(output) }];
}

