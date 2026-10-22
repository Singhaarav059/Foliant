"use client";

// Make PDF accessible (P2-16): a structure tree written from the page layout,
// following ISO 32000-1 §14.7-14.8 and PDF/UA-1 (ISO 14289-1):
//   - every text object (BT … ET) is marked content with an MCID, under the
//     heading (H1-H3), paragraph (P) or list item (L > LI > LBody) that
//     text.ts's layout puts its first glyph in
//   - images become Figures; other drawings (lines, fills, shadings) are
//     marked as artifacts, so screen readers skip them
//   - links and form fields get Link and Form elements pointing at them
//   - the catalog says the language, the title (shown in the window bar),
//     that the file is marked, and the XMP claims PDF/UA-1
// What it can't know is left for a person: alt text for figures (counted in
// the note), and tables, which are read as paragraphs.

import { PDFArray, PDFDict, PDFHexString, PDFName, PDFNumber, PDFRawStream, PDFRef, PDFString, type PDFObject } from "pdf-lib";
import { zlibSync } from "fflate";
import { baseName, bytesOf, closePdf, openPdf, pdfBlob, type Output, type Progress } from "./common";
import { contentBytes, tokens, type Token } from "./content";
import { openForEdit } from "./open";
import { blocks, bodySizeOf, documentText, type Block } from "./text";
import { pdfaClaim, writeXmp, xmpOf } from "./structure";
import { guessLanguage } from "../ai/extractive";

const N = (s: string) => PDFName.of(s);

type M = [number, number, number, number, number, number];
const mul = (m: M, n: M): M => [
  m[0] * n[0] + m[1] * n[2], m[0] * n[1] + m[1] * n[3],
  m[2] * n[0] + m[3] * n[2], m[2] * n[1] + m[3] * n[3],
  m[4] * n[0] + m[5] * n[2] + n[4], m[4] * n[1] + m[5] * n[3] + n[5],
];
const ID: M = [1, 0, 0, 1, 0, 0];

// One piece of the page's content to wrap: a text object, a picture, or an artifact.
export type Mark = {
  kind: "text" | "figure" | "artifact";
  start: number; end: number;
  // Where it begins on the page (user space): a text object's first glyph, a picture's top-left corner.
  at?: [number, number];
};

// Walks a content stream and finds the pieces to mark. Text objects are
// placed by their first glyph; pictures by the corner of their unit square;
// path drawing (from the first construction operator to the painting one),
// shadings and forms without text are artifacts.
export function marks(b: Uint8Array, isImage: (name: string) => "image" | "text" | "other"): { marks: Mark[]; mcidEdits: [number, number, string][] } {
  const out: Mark[] = [];
  const mcidEdits: [number, number, string][] = [];
  const at = { start: 0, end: 0 };
  let operands: { t: Token; start: number }[] = [];
  let ctm: M = ID;
  const stack: M[] = [];
  let tm: M = ID, tlm: M = ID, leading = 0;
  let text: Mark | null = null;
  let path: number | null = null;
  const nums = () => operands.flatMap((x) => ("num" in x.t ? [x.t.num] : []));
  const from = () => operands[0]?.start ?? at.start;
  const show = () => {
    if (text && !text.at) text.at = [mul(tm, ctm)[4], mul(tm, ctm)[5]];
  };
  const td = (tx: number, ty: number) => {
    tlm = mul([1, 0, 0, 1, tx, ty], tlm);
    tm = tlm;
  };
  for (const t of tokens(b, at)) {
    if ("inline" in t) {
      if (!text) out.push({ kind: "figure", start: at.start, end: at.end, at: [mul([1, 0, 0, 1, 0, 1], ctm)[4], mul([1, 0, 0, 1, 0, 1], ctm)[5]] });
      operands = [];
      continue;
    }
    if (!("op" in t)) {
      operands.push({ t, start: at.start });
      continue;
    }
    const v = nums();
    switch (t.op) {
      case "q": stack.push(ctm); break;
      case "Q": ctm = stack.pop() ?? ctm; break;
      case "cm": if (v.length === 6) ctm = mul(v as M, ctm); break;
      case "BT":
        tm = tlm = ID;
        text = { kind: "text", start: at.start, end: at.end };
        break;
      case "ET":
        if (text) {
          text.end = at.end;
          // A text object that shows nothing still has to be marked; it goes with its neighbours.
          out.push(text);
        }
        text = null;
        break;
      case "Tm": if (v.length === 6) tm = tlm = v as M; break;
      case "Td": if (v.length === 2) td(v[0], v[1]); break;
      case "TD": if (v.length === 2) { leading = -v[1]; td(v[0], v[1]); } break;
      case "TL": if (v.length === 1) leading = v[0]; break;
      case "T*": td(0, -leading); break;
      case "'": case "\"": td(0, -leading); show(); break;
      case "Tj": case "TJ": show(); break;
      case "BDC": {
        // Marked content already numbered (a file whose structure tree was
        // lost) would clash with the new numbers: it becomes a plain span.
        if (operands.some((x) => "name" in x.t && x.t.name === "MCID")) mcidEdits.push([from(), at.end, "/Span BMC"]);
        break;
      }
      case "m": case "l": case "c": case "v": case "y": case "h": case "re":
        if (!text && path === null) path = from();
        break;
      case "S": case "s": case "f": case "F": case "f*": case "B": case "B*": case "b": case "b*": case "n":
        if (!text && path !== null) out.push({ kind: "artifact", start: path, end: at.end });
        path = null;
        break;
      case "sh":
        if (!text) out.push({ kind: "artifact", start: from(), end: at.end });
        break;
      case "Do": {
        const last = operands.at(-1);
        const what = last && "name" in last.t ? isImage(last.t.name) : "other";
        if (text) break;
        // The unit square's top-left corner, where the picture starts.
        const corner = mul([1, 0, 0, 1, 0, 1], ctm);
        out.push(what === "image" ? { kind: "figure", start: from(), end: at.end, at: [corner[4], corner[5]] }
          : what === "text" ? { kind: "text", start: from(), end: at.end, at: [ctm[4], ctm[5]] }
          : { kind: "artifact", start: from(), end: at.end });
        break;
      }
    }
    operands = [];
  }
  return { marks: out, mcidEdits };
}

// `links`: links inside an element's text, written after its marked content.
type Elem = { s: string; mcids: number[]; top: number; left: number; block?: Block; alt?: string; kids?: Elem[]; links?: Elem[]; objr?: PDFRef; ref?: PDFRef };

export type TagOptions = { title: string; lang: string };

export async function tagPdf(file: File, o: TagOptions, progress?: Progress): Promise<Output[]> {
  const bytes = await bytesOf(file);
  const { doc } = await openForEdit(bytes, file.name);
  const ctx = doc.context;
  const stem = baseName(file.name);

  // The layout, as pdf.js reads it: lines grouped into headings, paragraphs and list items.
  const pdf = await openPdf(bytes.slice());
  const views: { convert: (x: number, y: number) => number[] }[] = [];
  let pages: Awaited<ReturnType<typeof documentText>>;
  try {
    pages = await documentText(pdf, (i) => progress?.(i, pdf.numPages * 2));
    for (let i = 1; i <= pdf.numPages; i++) {
      const vp = (await pdf.getPage(i)).getViewport({ scale: 1 });
      views.push({ convert: (x, y) => vp.convertToViewportPoint(x, y) });
    }
  } finally {
    await closePdf(pdf);
  }
  const body = bodySizeOf(pages);
  const layout = pages.map((p) => blocks(p.lines, body));
  // Heading levels in use, renumbered from 1 so none is skipped.
  const levels = [...new Set(layout.flat().filter((b) => b.kind === "heading").map((b) => b.level ?? 3))].sort();
  const hLevel = (b: Block) => levels.indexOf(b.level ?? 3) + 1;
  const allText = pages.map((p) => p.lines.map((l) => l.text).join("\n")).join("\n");

  const lang = o.lang && o.lang !== "auto" ? o.lang : guessLanguage(allText) ?? "en";
  const firstHeading = layout.flat().find((b) => b.kind === "heading")?.text;
  const title = o.title.trim() || doc.getTitle()?.trim() || firstHeading?.slice(0, 120) || stem;

  const already = doc.catalog.has(N("StructTreeRoot"));
  let figures = 0, tagged = 0;
  if (!already) {
    const root = ctx.obj({ Type: "StructTreeRoot" }) as PDFDict;
    const rootRef = ctx.register(root);
    const docElem = ctx.obj({ Type: "StructElem", S: "Document", P: rootRef }) as PDFDict;
    const docRef = ctx.register(docElem);
    const docKids: PDFRef[] = [];
    const parentNums: PDFObject[] = [];
    let nextKey = 0;

    for (const [pi, page] of doc.getPages().entries()) {
      progress?.(pages.length + pi, pages.length * 2);
      const resources = page.node.Resources();
      const xobjects = resources?.lookup(N("XObject"));
      const isImage = (name: string): "image" | "text" | "other" => {
        const x = xobjects instanceof PDFDict ? ctx.lookup(xobjects.get(N(name))) : undefined;
        if (!(x instanceof PDFRawStream)) return "other";
        if (String(x.dict.get(N("Subtype"))) === "/Image") return "image";
        const inner = contentBytes(x, doc)[0];
        return inner && [...tokens(inner)].some((t) => "op" in t && t.op === "BT") ? "text" : "other";
      };
      const parts = contentBytes(page.node.get(N("Contents")), doc);
      const all = new Uint8Array(parts.reduce((n, p) => n + p.length + 1, 0));
      let w = 0;
      for (const p of parts) { all.set(p, w); w += p.length; all[w++] = 10; }
      const { marks: found, mcidEdits } = marks(all, isImage);

      // Lines of this page's layout, each with its block, to place text objects.
      const view = views[pi];
      const lines = (layout[pi] ?? []).flatMap((block) => block.lines.map((line) => ({ line, block })));
      const blockFor = (x: number, y: number) => {
        const [vx, vy] = view.convert(x, y);
        let best: Block | undefined, dist = Infinity;
        for (const { line, block } of lines) {
          if (vx < line.x - line.size || vx > line.x + line.w + line.size) continue;
          if (vy < line.y - line.size * 0.5 || vy > line.y + line.size * 1.5) continue;
          const d = Math.abs(vy - (line.y + line.size * 0.8));
          if (d < dist) [best, dist] = [block, d];
        }
        return { block: best, top: vy, left: vx };
      };

      const elems = new Map<Block, Elem>();
      const own: Elem[] = [];
      // [from, to, text, order]: text replacing from…to; at one place, a mark's end goes before the next one's start.
      const inserts: [number, number, string, number][] = mcidEdits.map(([a, b, t]) => [a, b, t, 1]);
      let mcid = 0;
      const mcidElem: Elem[] = [];
      for (const m of found) {
        if (m.kind === "artifact") {
          inserts.push([m.start, m.start, "/Artifact BMC\n", 2], [m.end, m.end, "\nEMC", 0]);
          continue;
        }
        const place = m.at ? blockFor(m.at[0], m.at[1]) : { block: undefined, top: Infinity, left: 0 };
        let e: Elem;
        if (m.kind === "figure") {
          e = { s: "Figure", mcids: [], top: place.top, left: place.left };
          own.push(e);
          figures++;
        } else if (place.block) {
          e = elems.get(place.block) ?? { s: place.block.kind === "heading" ? `H${hLevel(place.block)}` : place.block.kind === "list" ? "LBody" : "P", mcids: [], top: place.top, left: place.left, block: place.block };
          if (!elems.has(place.block)) { elems.set(place.block, e); own.push(e); }
        } else {
          // Text the layout didn't place (drawn off the page, say): its own paragraph.
          e = { s: "P", mcids: [], top: place.top, left: place.left };
          own.push(e);
        }
        e.mcids.push(mcid);
        mcidElem[mcid] = e;
        inserts.push([m.start, m.start, `/${e.s} <</MCID ${mcid}>> BDC\n`, 2], [m.end, m.end, "\nEMC", 0]);
        mcid++;
      }
      if (!found.length && !mcidEdits.length) continue;
      tagged++;

      // The new content: the page's own, with the marks put in.
      inserts.sort((a, b) => a[0] - b[0] || a[3] - b[3]);
      const enc = new TextEncoder();
      const chunks: Uint8Array[] = [];
      let pos = 0;
      for (const [s, e, txt] of inserts) {
        if (s < pos) continue;
        chunks.push(all.subarray(pos, s), enc.encode(txt));
        pos = e;
      }
      chunks.push(all.subarray(pos));
      const len = chunks.reduce((n, c) => n + c.length, 0);
      const joined = new Uint8Array(len);
      let k = 0;
      for (const c of chunks) { joined.set(c, k); k += c.length; }
      page.node.set(N("Contents"), ctx.register(PDFRawStream.of(ctx.obj({ Filter: "FlateDecode" }) as PDFDict, zlibSync(joined))));

      // Links and form fields: elements that point at the annotation.
      const annotElems: Elem[] = [];
      for (const ref of page.node.Annots()?.asArray() ?? []) {
        const a = ctx.lookup(ref);
        if (!(a instanceof PDFDict) || !(ref instanceof PDFRef)) continue;
        const sub = String(a.get(N("Subtype")));
        if (sub !== "/Link" && sub !== "/Widget") continue;
        const rect = a.lookup(N("Rect"));
        const r = rect instanceof PDFArray ? rect.asArray().map((x) => (x instanceof PDFNumber ? x.asNumber() : 0)) : [0, 0, 0, 0];
        const [vx, vy] = view.convert(Math.min(r[0], r[2]), Math.max(r[1], r[3]));
        const e: Elem = { s: sub === "/Link" ? "Link" : "Form", mcids: [], top: vy, left: vx, objr: ref };
        annotElems.push(e);
        // A link over a paragraph's words belongs to that paragraph (PDF/UA-1 7.18.5).
        const [cx, cy] = view.convert((r[0] + r[2]) / 2, (r[1] + r[3]) / 2);
        const host = e.s === "Link" ? own.find((o) => o.block?.lines.some((l) => cx >= l.x && cx <= l.x + l.w && cy >= l.y - 2 && cy <= l.y + l.size * 1.4)) : undefined;
        if (host) (host.links ??= []).push(e);
        else own.push(e);
      }

      // Top-level elements in reading order: down the page, then across.
      // Consecutive list items share one list.
      own.sort((a, b) => (Math.abs(a.top - b.top) > 2 ? a.top - b.top : a.left - b.left));
      const pageRef = page.ref;
      const top: Elem[] = [];
      for (const e of own) {
        if (e.s === "LBody") {
          const li: Elem = { s: "LI", mcids: [], top: e.top, left: e.left, kids: [e] };
          const last = top.at(-1);
          if (last?.s === "L") last.kids!.push(li);
          else top.push({ s: "L", mcids: [], top: e.top, left: e.left, kids: [li] });
        } else top.push(e);
      }
      const write = (e: Elem, parent: PDFRef): PDFRef => {
        const d = ctx.obj({ Type: "StructElem", S: e.s, P: parent, Pg: pageRef }) as PDFDict;
        const ref = ctx.register(d);
        e.ref = ref;
        if (e.alt) d.set(N("Alt"), PDFString.of(e.alt));
        if (e.objr) {
          const key = nextKey++;
          const annot = ctx.lookup(e.objr) as PDFDict;
          annot.set(N("StructParent"), PDFNumber.of(key));
          d.set(N("K"), ctx.obj({ Type: "OBJR", Obj: e.objr, Pg: pageRef }));
          parentNums.push(PDFNumber.of(key), ref);
          // The link's text is its contents, for screen readers.
          if (e.s === "Link" && !annot.has(N("Contents"))) annot.set(N("Contents"), PDFString.of(linkText(annot)));
        } else if (e.kids) d.set(N("K"), ctx.obj(e.kids.map((kid) => write(kid, ref))));
        else if (e.links) d.set(N("K"), ctx.obj([...e.mcids.map((m) => PDFNumber.of(m)), ...e.links.map((l) => write(l, ref))]));
        else d.set(N("K"), e.mcids.length === 1 ? PDFNumber.of(e.mcids[0]) : ctx.obj(e.mcids));
        return ref;
      };
      for (const e of top) docKids.push(write(e, docRef));
      // The parent tree: for this page, the element that holds each MCID.
      if (mcid) {
        const key = nextKey++;
        page.node.set(N("StructParents"), PDFNumber.of(key));
        parentNums.push(PDFNumber.of(key), ctx.obj(mcidElem.map((e) => e.ref!)));
      }
      // Tab order follows the structure (PDF/UA-1 7.18.3).
      if (annotElems.length) page.node.set(N("Tabs"), N("S"));
    }

    docElem.set(N("K"), ctx.obj(docKids));
    root.set(N("K"), docRef);
    // Number trees list keys in ascending order.
    const pairs: [number, PDFObject][] = [];
    for (let i = 0; i < parentNums.length; i += 2) pairs.push([(parentNums[i] as PDFNumber).asNumber(), parentNums[i + 1]]);
    pairs.sort((a, b) => a[0] - b[0]);
    root.set(N("ParentTree"), ctx.register(ctx.obj({ Nums: pairs.flatMap(([k, v]) => [PDFNumber.of(k), v]) })));
    root.set(N("ParentTreeNextKey"), PDFNumber.of(nextKey));
    doc.catalog.set(N("StructTreeRoot"), rootRef);
  }

  doc.catalog.set(N("MarkInfo"), ctx.obj({ Marked: true }));
  doc.catalog.set(N("Lang"), PDFString.of(lang));
  const prefs = doc.catalog.lookup(N("ViewerPreferences"));
  if (prefs instanceof PDFDict) prefs.set(N("DisplayDocTitle"), ctx.obj(true));
  else doc.catalog.set(N("ViewerPreferences"), ctx.obj({ DisplayDocTitle: true }));
  doc.setTitle(title);
  writeXmp(doc, pdfaClaim(xmpOf(doc)), 1);

  const out = await doc.save({ useObjectStreams: true, addDefaultPage: false, updateFieldAppearances: false });
  return [{
    name: `${stem}-accessible.pdf`, blob: pdfBlob(out),
    note: already ? "tagKept" : `tagged:${tagged}:${figures}`,
  }];
}

// A link's own words when it has any, else where it goes.
function linkText(annot: PDFDict) {
  const action = annot.lookup(N("A"));
  const uri = action instanceof PDFDict ? action.lookup(N("URI")) : undefined;
  return uri instanceof PDFString || uri instanceof PDFHexString ? uri.decodeText() : "Link";
}
