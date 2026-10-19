// PDF → PDF/A (1b, 2b, 2u, 3b or 3u) that keeps the pages as they are, the way Ghostscript and
// OCRmyPDF do it: fix what the standard forbids instead of turning pages into
// pictures. What it fixes:
//   - fonts named but not embedded get a metric-compatible substitute (Arimo,
//     Tinos, Cousine, Carlito, Caladea) with widths from the substitute itself
//   - scripts, attachments, forbidden actions and annotation types are removed;
//     annotations become printable; appearance streams keep only /N
//   - transfer functions, halftones, image interpolation, OPI and external
//     stream data are dropped; LZW streams are re-encoded with Flate
// Pages it can't fix (device CMYK under an sRGB output intent, fonts it can't
// substitute, PostScript XObjects, form fields without appearances) are
// returned so the caller can render just those pages as images.
// Levels, from ISO 19005:
//   1b  PDF 1.4: no transparency, JPEG 2000, layers or 1.5+ annotation types;
//       pages that use them are rendered instead
//   2u, 3u  every character maps to Unicode; when a font can't, the file is
//       made to the b level of the same part instead (report.level says which)
//   3b, 3u  embedded files stay, as associated files with an AFRelationship

import "regenerator-runtime/runtime";
import fontkit from "@pdf-lib/fontkit";
import { unzlibSync } from "fflate";
import {
  PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFRawStream, PDFRef, PDFStream, PDFString, decodePDFRawStream,
  type PDFObject,
} from "pdf-lib";
import { VENDOR } from "../vendor";
import { contentBytes, tokens } from "./content";
import { STANDARD, WIN_ANSI, unicodeOf, type Encoding } from "./encodings";

// Tests read the files from disk instead.
export const pdfaFonts = {
  load: async (file: string): Promise<Uint8Array> => new Uint8Array(await (await fetch(`${VENDOR}pdfa-fonts/${file}`)).arrayBuffer()),
};

export const PDFA_LEVELS = ["1b", "2b", "2u", "3b", "3u"] as const;
export type PdfaLevel = (typeof PDFA_LEVELS)[number];
// level: the level the file was made to, which is the one asked for unless it had to come down.
export type PdfaReport = { raster: Set<number>; substituted: Map<string, string>; removed: Set<string>; level: PdfaLevel };

const N = (s: string) => PDFName.of(s);

// ── Fonts

type Table = { tag: number; data: Uint8Array };

// An OpenType/TrueType file from its tables.
function sfntOf(version: number, tables: Table[]): Uint8Array {
  const count = tables.length;
  const pad = (n: number) => (n + 3) & ~3;
  const size = 12 + 16 * count + tables.reduce((s, t) => s + pad(t.data.length), 0);
  const out = new Uint8Array(size);
  const o = new DataView(out.buffer);
  const log = Math.floor(Math.log2(count));
  o.setUint32(0, version);
  o.setUint16(4, count);
  o.setUint16(6, 16 * 2 ** log);
  o.setUint16(8, log);
  o.setUint16(10, count * 16 - 16 * 2 ** log);
  let at = 12 + 16 * count;
  tables.forEach((t, i) => {
    out.set(t.data, at);
    let sum = 0;
    for (let j = 0; j < pad(t.data.length); j += 4) sum = (sum + o.getUint32(at + j)) >>> 0;
    o.setUint32(12 + i * 16, t.tag);
    o.setUint32(16 + i * 16, sum);
    o.setUint32(20 + i * 16, at);
    o.setUint32(24 + i * 16, t.data.length);
    at += pad(t.data.length);
  });
  return out;
}

// WOFF 1.0 → plain OpenType/TrueType (what a PDF embeds).
function woffToSfnt(w: Uint8Array): Uint8Array {
  const v = new DataView(w.buffer, w.byteOffset, w.byteLength);
  const tables = Array.from({ length: v.getUint16(12) }, (_, i) => {
    const e = 44 + i * 20;
    const offset = v.getUint32(e + 4), comp = v.getUint32(e + 8), orig = v.getUint32(e + 12);
    const raw = w.subarray(offset, offset + comp);
    return { tag: v.getUint32(e), data: comp < orig ? unzlibSync(raw) : raw };
  });
  return sfntOf(v.getUint32(4), tables);
}

const CMAP = 0x636d6170;

// The same font with one cmap, (3,0) symbolic, mapping 0xF000 + code to a glyph:
// what PDF/A-1 asks of a symbolic TrueType font (ISO 19005-1, 6.3.7).
function withSymbolicCmap(sfnt: Uint8Array, glyphs: Map<number, number>): Uint8Array {
  const v = new DataView(sfnt.buffer, sfnt.byteOffset, sfnt.byteLength);
  const tables = Array.from({ length: v.getUint16(4) }, (_, i) => {
    const at = v.getUint32(20 + i * 16);
    return { tag: v.getUint32(12 + i * 16), data: sfnt.subarray(at, at + v.getUint32(24 + i * 16)) };
  });
  // Format 4, one segment per code, then the 0xFFFF end segment.
  const codes = [...glyphs.keys()].sort((a, b) => a - b);
  const segs = codes.length + 1;
  const log = Math.floor(Math.log2(segs));
  const sub = new DataView(new ArrayBuffer(16 + 8 * segs));
  [4, 16 + 8 * segs, 0, segs * 2, 2 * 2 ** log, log, 2 * segs - 2 * 2 ** log].forEach((x, i) => sub.setUint16(i * 2, x));
  const ends = 14, starts = 16 + 2 * segs, deltas = 16 + 4 * segs; // idRangeOffset stays 0
  codes.forEach((code, i) => {
    sub.setUint16(ends + i * 2, 0xf000 + code);
    sub.setUint16(starts + i * 2, 0xf000 + code);
    sub.setUint16(deltas + i * 2, (glyphs.get(code)! - 0xf000 - code) & 0xffff);
  });
  sub.setUint16(ends + codes.length * 2, 0xffff);
  sub.setUint16(starts + codes.length * 2, 0xffff);
  sub.setUint16(deltas + codes.length * 2, 1);
  const cmap = new Uint8Array(12 + sub.byteLength);
  const c = new DataView(cmap.buffer);
  c.setUint16(2, 1);
  c.setUint16(4, 3);
  c.setUint16(6, 0);
  c.setUint32(8, 12);
  cmap.set(new Uint8Array(sub.buffer), 12);
  return sfntOf(v.getUint32(0), tables.map((t) => (t.tag === CMAP ? { tag: CMAP, data: cmap } : t)));
}

// A ToUnicode map for a simple font.
function toUnicodeCMap(unicode: Map<number, number>): string {
  const hex = (n: number, digits: number) => n.toString(16).toUpperCase().padStart(digits, "0");
  const utf16 = (cp: number) => {
    const s = String.fromCodePoint(cp);
    return Array.from({ length: s.length }, (_, i) => hex(s.charCodeAt(i), 4)).join("");
  };
  const entries = [...unicode].map(([code, cp]) => `<${hex(code, 2)}> <${utf16(cp)}>`);
  const blocks: string[] = [];
  for (let i = 0; i < entries.length; i += 100) blocks.push(`${entries.slice(i, i + 100).length} beginbfchar\n${entries.slice(i, i + 100).join("\n")}\nendbfchar`);
  return [
    "/CIDInit /ProcSet findresource begin", "12 dict begin", "begincmap",
    "/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def", "/CMapName /Adobe-Identity-UCS def", "/CMapType 2 def",
    "1 begincodespacerange", "<00> <FF>", "endcodespacerange", ...blocks,
    "endcmap", "CMapName currentdict /CMap defineresource pop", "end", "end",
  ].join("\n");
}

type Face = { sfnt: Uint8Array; font: ReturnType<typeof fontkit.create>; family: string };
const faces = new Map<string, Promise<Face>>();

function loadFace(family: string, bold: boolean, italic: boolean): Promise<Face> {
  const file = `${family}-latin-${bold ? 700 : 400}-${italic ? "italic" : "normal"}.woff`;
  let p = faces.get(file);
  if (!p) {
    p = pdfaFonts.load(file).then((woff) => {
      const sfnt = woffToSfnt(woff);
      return { sfnt, font: fontkit.create(sfnt), family };
    });
    faces.set(file, p);
  }
  return p;
}

// Which stand-in, by the font's name and descriptor flags.
function pickFamily(name: string, flags: number) {
  if (/courier|mono|consol|typewriter/i.test(name) || flags & 1) return "cousine";
  if (/calibri/i.test(name)) return "carlito";
  if (/cambria/i.test(name)) return "caladea";
  if (/times|roman|serif|georgia|garamond|minion|palatino|book|century|cambria/i.test(name) && !/sans/i.test(name)) return "tinos";
  if (flags & 2 && !/arial|helvetica|sans|verdana|tahoma|segoe/i.test(name)) return "tinos";
  return "arimo";
}

// code → glyph name for a simple font.
function encodingOf(font: PDFDict, standardType1: boolean): Encoding | null {
  const enc = font.lookup(N("Encoding"));
  const base = (name: string | undefined) =>
    name === "/WinAnsiEncoding" ? WIN_ANSI : name === "/StandardEncoding" ? STANDARD : name === undefined ? (standardType1 ? STANDARD : WIN_ANSI) : null;
  if (enc instanceof PDFName) return base(enc.asString());
  if (enc === undefined) return base(undefined);
  if (!(enc instanceof PDFDict)) return null;
  const b = enc.lookup(N("BaseEncoding"));
  const table = base(b instanceof PDFName ? b.asString() : undefined);
  if (!table) return null;
  const out = [...table];
  const diffs = enc.lookup(N("Differences"));
  if (diffs instanceof PDFArray) {
    let code = 0;
    for (const d of diffs.asArray()) {
      if (d instanceof PDFNumber) code = d.asNumber();
      else if (d instanceof PDFName) out[code++] = d.asString().slice(1);
    }
  }
  return out;
}

const embeddedFile = (desc: PDFDict | undefined) => !!desc && ["FontFile", "FontFile2", "FontFile3"].some((k) => desc.get(N(k)));

// ── Colour

type Ctx = { doc: PDFDocument };

// True when a colour space rests on DeviceCMYK, which an sRGB output intent doesn't cover.
function cmykSpace(cs: PDFObject | undefined, resources: PDFDict | undefined, c: Ctx, depth = 0): boolean {
  if (depth > 8 || cs === undefined) return false;
  const o = cs instanceof PDFRef ? c.doc.context.lookup(cs) : cs;
  if (o instanceof PDFName) {
    const n = o.asString();
    if (n === "/DeviceCMYK" || n === "/CMYK") return true;
    if (["/DeviceRGB", "/DeviceGray", "/RGB", "/G", "/Pattern"].includes(n)) return false;
    const named = resources?.lookupMaybe(N("ColorSpace"), PDFDict)?.get(N(n.slice(1)));
    return named ? cmykSpace(named, resources, c, depth + 1) : false;
  }
  if (o instanceof PDFArray) {
    const kind = String(o.get(0));
    if (kind === "/Indexed" || kind === "/I" || kind === "/Pattern") return cmykSpace(o.get(1), resources, c, depth + 1);
    if (kind === "/Separation") return cmykSpace(o.get(2), resources, c, depth + 1);
    if (kind === "/DeviceN") return cmykSpace(o.get(2), resources, c, depth + 1);
  }
  return false;
}

// ── Scanning content

// transparency and jpx only matter to PDF/A-1, which allows neither.
type Usage = { cmyk: boolean; postscript: boolean; transparency: boolean; jpx: boolean; fonts: Map<PDFDict, Set<number>> };

// A graphics state that blends, fades or masks.
function transparentState(gs: PDFDict): boolean {
  const smask = gs.lookup(N("SMask"));
  if (smask instanceof PDFDict) return true;
  for (const k of ["CA", "ca"]) {
    const v = gs.lookup(N(k));
    if (v instanceof PDFNumber && v.asNumber() < 1) return true;
  }
  const bm = gs.lookup(N("BM"));
  const mode = bm instanceof PDFArray ? bm.get(0) : bm;
  return mode !== undefined && mode !== N("Normal") && mode !== N("Compatible");
}

function scan(streams: Uint8Array[], resources: PDFDict | undefined, u: Usage, c: Ctx, seen: Set<PDFObject>, depth = 0) {
  if (depth > 20) return;
  const fonts = resources?.lookupMaybe(N("Font"), PDFDict);
  const xobjects = resources?.lookupMaybe(N("XObject"), PDFDict);
  const shadings = resources?.lookupMaybe(N("Shading"), PDFDict);
  let font: PDFDict | undefined;
  let operands: (number | string | Uint8Array | null)[] = [];
  const recordText = (s: Uint8Array) => {
    if (!font) return;
    let set = u.fonts.get(font);
    if (!set) u.fonts.set(font, (set = new Set()));
    // Composite fonts with an Identity encoding draw two-byte codes; others, one byte each.
    const enc = font.get(N("Subtype")) === N("Type0") ? font.get(N("Encoding")) : undefined;
    if (enc === N("Identity-H") || enc === N("Identity-V")) for (let i = 0; i + 1 < s.length; i += 2) set.add((s[i] << 8) | s[i + 1]);
    else for (const b of s) set.add(b);
  };
  const form = (x: PDFRawStream) => {
    if (seen.has(x)) return;
    seen.add(x);
    scan(contentBytes(x, c.doc), x.dict.lookupMaybe(N("Resources"), PDFDict) ?? resources, u, c, seen, depth + 1);
  };

  for (const bytes of streams) {
    for (const t of tokens(bytes)) {
      if ("num" in t) { operands.push(t.num); continue; }
      if ("name" in t) { operands.push(t.name); continue; }
      if ("str" in t) {
        operands.push(t.str);
        continue;
      }
      if ("inline" in t) {
        const cs = t.inline.CS ?? t.inline.ColorSpace;
        if (typeof cs === "string" && cmykSpace(N(cs), resources, c)) u.cmyk = true;
        continue;
      }
      if ("mark" in t) continue;
      const last = operands[operands.length - 1];
      switch (t.op) {
        case "k": case "K": u.cmyk = true; break;
        case "cs": case "CS":
          if (typeof last === "string" && cmykSpace(N(last), resources, c)) u.cmyk = true;
          break;
        case "Tf": {
          const name = operands[operands.length - 2];
          const f = typeof name === "string" ? fonts?.get(N(name)) : undefined;
          font = (f instanceof PDFRef ? c.doc.context.lookup(f) : f) as PDFDict | undefined;
          // Type3 glyphs are little content streams of their own.
          if (font instanceof PDFDict && font.get(N("Subtype")) === N("Type3") && !seen.has(font)) {
            seen.add(font);
            const procs = font.lookupMaybe(N("CharProcs"), PDFDict);
            const res = font.lookupMaybe(N("Resources"), PDFDict) ?? resources;
            for (const [, p] of procs?.entries() ?? []) {
              const s = c.doc.context.lookup(p);
              if (s instanceof PDFRawStream) scan(contentBytes(s, c.doc), res, u, c, seen, depth + 1);
            }
          }
          break;
        }
        case "Tj": case "'": case "\"":
          if (last instanceof Uint8Array) recordText(last);
          break;
        case "TJ":
          for (const o of operands) if (o instanceof Uint8Array) recordText(o);
          break;
        case "sh": {
          const sh = typeof last === "string" ? shadings?.lookup(N(last)) : undefined;
          const d = sh instanceof PDFDict ? sh : sh instanceof PDFStream ? sh.dict : undefined;
          if (d && cmykSpace(d.get(N("ColorSpace")), resources, c)) u.cmyk = true;
          break;
        }
        case "Do": {
          const ref = typeof last === "string" ? xobjects?.get(N(last)) : undefined;
          const x = ref instanceof PDFRef ? c.doc.context.lookup(ref) : ref;
          if (!(x instanceof PDFRawStream)) break;
          const sub = x.dict.get(N("Subtype"));
          if (sub === N("PS") || x.dict.get(N("Subtype2")) === N("PS")) u.postscript = true;
          else if (sub === N("Image")) {
            if (!x.dict.get(N("ImageMask")) && cmykSpace(x.dict.get(N("ColorSpace")), resources, c)) u.cmyk = true;
            const sid = x.dict.lookup(N("SMaskInData"));
            if (x.dict.lookup(N("SMask")) instanceof PDFStream || (sid instanceof PDFNumber && sid.asNumber() !== 0)) u.transparency = true;
            const f = x.dict.lookup(N("Filter"));
            if (f === N("JPXDecode") || (f instanceof PDFArray && f.asArray().includes(N("JPXDecode")))) u.jpx = true;
            const smask = x.dict.lookup(N("SMask"));
            if (smask instanceof PDFRawStream && cmykSpace(smask.dict.get(N("ColorSpace")), resources, c)) u.cmyk = true;
          } else if (sub === N("Form")) form(x);
          break;
        }
      }
      operands = [];
    }
  }

  // Patterns and soft-mask groups draw content too, whether or not this stream names them.
  for (const [, p] of resources?.lookupMaybe(N("Pattern"), PDFDict)?.entries() ?? []) {
    const pat = c.doc.context.lookup(p);
    if (pat instanceof PDFRawStream) form(pat);
    else if (pat instanceof PDFDict) {
      const sh = pat.lookup(N("Shading"));
      const d = sh instanceof PDFDict ? sh : sh instanceof PDFStream ? sh.dict : undefined;
      if (d && cmykSpace(d.get(N("ColorSpace")), resources, c)) u.cmyk = true;
      const gs = pat.lookup(N("ExtGState"));
      if (gs instanceof PDFDict && transparentState(gs)) u.transparency = true;
    }
  }
  for (const [, g] of resources?.lookupMaybe(N("ExtGState"), PDFDict)?.entries() ?? []) {
    const gs = c.doc.context.lookup(g);
    if (gs instanceof PDFDict && transparentState(gs)) u.transparency = true;
    const smask = gs instanceof PDFDict ? gs.lookup(N("SMask")) : undefined;
    const group = smask instanceof PDFDict ? smask.lookup(N("G")) : undefined;
    if (group instanceof PDFRawStream) form(group);
  }
}

// ── Document clean-up

const BAD_ACTIONS = new Set(["/Launch", "/Sound", "/Movie", "/ResetForm", "/ImportData", "/JavaScript", "/Hide", "/SetOCGState", "/Rendition", "/Trans", "/GoTo3DView", "/GoToE"]);
const GOOD_NAMED = new Set(["/NextPage", "/PrevPage", "/FirstPage", "/LastPage"]);
const BAD_ANNOTS = new Set(["/Sound", "/Movie", "/Screen", "/3D", "/RichMedia", "/FileAttachment"]);
// The annotation types PDF 1.4, and so PDF/A-1, knows.
const PDF14_ANNOTS = new Set(["/Text", "/Link", "/FreeText", "/Line", "/Square", "/Circle", "/Highlight", "/Underline", "/Squiggly", "/StrikeOut", "/Stamp", "/Ink", "/Popup", "/Widget", "/PrinterMark", "/TrapNet"]);

function badAction(a: PDFObject | undefined, c: Ctx): boolean {
  const d = a instanceof PDFRef ? c.doc.context.lookup(a) : a;
  if (!(d instanceof PDFDict)) return false;
  const s = String(d.get(N("S")));
  if (BAD_ACTIONS.has(s)) return true;
  if (s === "/Named") return !GOOD_NAMED.has(String(d.get(N("N"))));
  return badAction(d.get(N("Next")), c);
}

// Each [name, value] pair in a name tree, leaves in order.
function nameTreeEntries(node: PDFDict | undefined, doc: PDFDocument, out: [PDFObject, PDFObject][] = [], depth = 0) {
  if (!node || depth > 32) return out;
  const names = node.lookupMaybe(N("Names"), PDFArray)?.asArray() ?? [];
  for (let i = 0; i + 1 < names.length; i += 2) out.push([names[i], names[i + 1]]);
  for (const kid of node.lookupMaybe(N("Kids"), PDFArray)?.asArray() ?? []) nameTreeEntries(doc.context.lookupMaybe(kid, PDFDict), doc, out, depth + 1);
  return out;
}

// Every dictionary in the file's objects, nested direct ones too (references aren't
// followed), with the reference of the object when it is one of the file's own.
function eachDict(doc: PDFDocument, fn: (d: PDFDict, ref: PDFRef | undefined) => void) {
  const walk = (o: PDFObject, ref: PDFRef | undefined, depth: number) => {
    if (depth > 32) return;
    const d = o instanceof PDFStream ? o.dict : o instanceof PDFDict ? o : undefined;
    if (d) {
      fn(d, ref);
      for (const [, v] of d.entries()) walk(v, undefined, depth + 1);
    } else if (o instanceof PDFArray) for (const v of o.asArray()) walk(v, undefined, depth + 1);
  };
  for (const [ref, o] of doc.context.enumerateIndirectObjects()) walk(o, ref, 0);
}

// Resources, glyph procedures and named destinations are keyed by any name, AF, EF and RF
// among them, so those keys mean files only where the value looks like one.
// A file specification: typed as one, or untyped with an EF holding only file entries.
const FILE_KEYS = new Set(["/F", "/UF", "/DOS", "/Mac", "/Unix"]);
function isFileSpec(d: PDFDict, doc: PDFDocument): boolean {
  const type = d.get(N("Type"));
  if (type === N("Filespec")) return true;
  if (type !== undefined) return false;
  const ef = doc.context.lookup(d.get(N("EF")));
  return ef instanceof PDFDict && ef.keys().length > 0 && ef.keys().every((k) => FILE_KEYS.has(String(k)));
}
// An associated-files list: an array of file specifications. Colour spaces and destinations,
// the arrays a resource or destination could hold instead, always contain a name.
function afList(d: PDFDict, doc: PDFDocument): PDFArray | undefined {
  const af = d.lookup(N("AF"));
  return af instanceof PDFArray && !af.asArray().some((o) => doc.context.lookup(o) instanceof PDFName) ? af : undefined;
}

// PDF/A-1 forbids embedded files and PDF/A-2 allows only PDF/A ones, which can't be
// checked here: every file goes, wherever it is listed, and its bytes leave the file.
function stripFiles(doc: PDFDocument, removed: Set<string>) {
  eachDict(doc, (d) => {
    const keys = [...(afList(d, doc) ? ["AF"] : []), ...(d.has(N("EF")) && isFileSpec(d, doc) ? ["EF", "RF"] : [])];
    for (const k of keys)
      if (d.has(N(k))) {
        d.delete(N(k));
        removed.add("attachments");
      }
  });
  for (const [ref, o] of doc.context.enumerateIndirectObjects())
    if (o instanceof PDFStream && o.dict.get(N("Type")) === N("EmbeddedFile")) doc.context.delete(ref);
}

// PDF/A-3: embedded files stay when they're really embedded, each one an
// associated file of the document or of a part of it (ISO 19005-3, 6.8).
function associateFiles(doc: PDFDocument, removed: Set<string>) {
  const ctx = doc.context;
  const valid = new Map<PDFDict, boolean>();
  // Whether a file specification embeds its file; one that does gets what PDF/A-3 asks of it.
  const embeds = (spec: PDFDict, key?: PDFObject) => {
    let ok = valid.get(spec);
    if (ok !== undefined) return ok;
    const ef = spec.lookup(N("EF"));
    const file = ef instanceof PDFDict ? ef.lookup(N("F")) ?? ef.lookup(N("UF")) : undefined;
    ok = file instanceof PDFStream;
    if (file instanceof PDFStream) {
      const label = spec.get(N("UF")) ?? spec.get(N("F")) ?? key ?? PDFString.of("attachment");
      if (!spec.has(N("F"))) spec.set(N("F"), label);
      if (!spec.has(N("UF"))) spec.set(N("UF"), label);
      spec.set(N("Type"), N("Filespec"));
      if (!(spec.get(N("AFRelationship")) instanceof PDFName)) spec.set(N("AFRelationship"), N("Unspecified"));
      if (!(file.dict.get(N("Subtype")) instanceof PDFName)) file.dict.set(N("Subtype"), N("application/octet-stream"));
      const params = file.dict.lookupMaybe(N("Params"), PDFDict) ?? ctx.obj({});
      if (!params.has(N("ModDate"))) params.set(N("ModDate"), PDFString.fromDate(new Date()));
      file.dict.set(N("Params"), params);
    }
    valid.set(spec, ok);
    return ok;
  };

  // The attachments list: each file kept is associated with the document.
  const af = afList(doc.catalog, doc)?.asArray().slice() ?? [];
  const names = doc.catalog.lookupMaybe(N("Names"), PDFDict);
  if (names?.has(N("EmbeddedFiles"))) {
    const kept: PDFObject[] = [];
    for (const [key, value] of nameTreeEntries(names.lookupMaybe(N("EmbeddedFiles"), PDFDict), doc)) {
      const spec = ctx.lookup(value);
      if (!(spec instanceof PDFDict) || !embeds(spec, key)) {
        removed.add("external file references");
        continue;
      }
      const ref = value instanceof PDFRef ? value : ctx.register(spec);
      kept.push(key, ref);
      if (!af.some((r) => r === ref)) af.push(ref);
    }
    names.set(N("EmbeddedFiles"), ctx.obj({ Names: kept }));
    if (af.length) doc.catalog.set(N("AF"), ctx.obj(af));
  }

  // Every AF list, the document's and its parts', keeps only files really embedded.
  const associated = new Set<PDFDict>();
  eachDict(doc, (d) => {
    const list = afList(d, doc)?.asArray();
    if (!list) return;
    const keep = list.filter((r) => {
      const spec = ctx.lookup(r);
      if (!(spec instanceof PDFDict) || !embeds(spec)) return false;
      associated.add(spec);
      return true;
    });
    if (keep.length < list.length || !list.length) removed.add("external file references");
    if (keep.length) d.set(N("AF"), ctx.obj(keep));
    else d.delete(N("AF"));
  });

  // Files embedded anywhere else become associated files of the document.
  const extra: PDFRef[] = [];
  eachDict(doc, (d, ref) => {
    if (!d.has(N("EF")) || associated.has(d) || !isFileSpec(d, doc)) return;
    if (ref && embeds(d)) extra.push(ref);
    else {
      d.delete(N("EF"));
      d.delete(N("RF"));
      removed.add("attachments");
    }
  });
  if (extra.length) doc.catalog.set(N("AF"), ctx.obj([...(afList(doc.catalog, doc)?.asArray() ?? []), ...extra]));
}

function cleanDocument(doc: PDFDocument, removed: Set<string>, part: number) {
  const c = { doc };
  const cat = doc.catalog;
  const drop = (d: PDFDict, key: string, why: string) => {
    if (d.has(N(key))) {
      d.delete(N(key));
      removed.add(why);
    }
  };
  drop(cat, "AA", "document actions");
  drop(cat, "Collection", "portfolio");
  drop(cat, "Perms", "permissions");
  drop(cat, "Requirements", "requirements");
  if (part === 1) {
    // PDF 1.4 has no layers: everything shows, as it prints.
    drop(cat, "OCProperties", "layers");
    cat.delete(N("Version"));
  }
  if (badAction(cat.get(N("OpenAction")), c)) drop(cat, "OpenAction", "open action");
  const names = cat.lookupMaybe(N("Names"), PDFDict);
  if (names) {
    drop(names, "JavaScript", "scripts");
    if (part < 3) drop(names, "EmbeddedFiles", "attachments");
    drop(names, "AlternatePresentations", "alternate presentations");
  }
  if (part === 3) associateFiles(doc, removed);
  else stripFiles(doc, removed);
  const form = cat.lookupMaybe(N("AcroForm"), PDFDict);
  if (form) {
    drop(form, "XFA", "XFA form data");
    form.delete(N("NeedAppearances"));
  }
  // Optional content configurations need names and no automatic states.
  const oc = cat.lookupMaybe(N("OCProperties"), PDFDict);
  if (oc) {
    const configs = [oc.lookupMaybe(N("D"), PDFDict), ...(oc.lookupMaybe(N("Configs"), PDFArray)?.asArray().map((r) => doc.context.lookup(r)) ?? [])];
    configs.forEach((cfg, i) => {
      if (!(cfg instanceof PDFDict)) return;
      if (!cfg.has(N("Name"))) cfg.set(N("Name"), doc.context.obj(i ? `Layers ${i}` : "Default"));
      cfg.delete(N("AS"));
    });
  }
  // Bookmarks with forbidden actions keep their place but lose the action.
  const walk = (ref: PDFObject | undefined, n = 0) => {
    for (let item = ref instanceof PDFRef ? doc.context.lookup(ref) : ref; item instanceof PDFDict && n < 100000; n++) {
      if (badAction(item.get(N("A")), c)) drop(item, "A", "bookmark actions");
      walk(item.get(N("First")), n + 1);
      const next = item.get(N("Next"));
      item = next instanceof PDFRef ? doc.context.lookup(next) : undefined;
    }
  };
  walk(cat.lookupMaybe(N("Outlines"), PDFDict)?.get(N("First")));

  // Every object: stream and graphics-state keys PDF/A forbids.
  for (const [ref, obj] of doc.context.enumerateIndirectObjects()) {
    const d = obj instanceof PDFRawStream ? obj.dict : obj instanceof PDFDict ? obj : null;
    if (!d) continue;
    for (const k of ["F", "FFilter", "FDecodeParms"]) if (obj instanceof PDFRawStream) drop(d, k, "external stream data");
    if (d.get(N("Type")) === N("ExtGState")) {
      for (const k of ["TR", "HT", "HTP", "HTO"]) drop(d, k, "transfer functions and halftones");
      if (d.get(N("TR2")) !== N("Default")) drop(d, "TR2", "transfer functions and halftones");
    }
    if (d.get(N("Subtype")) === N("Image")) {
      d.delete(N("Interpolate"));
      drop(d, "Alternates", "alternate images");
      drop(d, "OPI", "OPI");
    }
    if (d.get(N("Subtype")) === N("Form")) {
      drop(d, "OPI", "OPI");
      drop(d, "Ref", "reference XObjects");
      // A transparency group of opaque content looks the same without it; pages with transparency are rendered.
      if (part === 1 && d.lookupMaybe(N("Group"), PDFDict)?.get(N("S")) === N("Transparency")) d.delete(N("Group"));
    }
    // LZW isn't allowed; Flate is.
    if (obj instanceof PDFRawStream) {
      const f = d.lookup(N("Filter"));
      const lzw = f === N("LZWDecode") || (f instanceof PDFArray && f.asArray().some((x) => x === N("LZWDecode")));
      if (lzw) {
        try {
          const raw = decodePDFRawStream(obj).decode();
          const nd = d.clone(doc.context);
          nd.delete(N("Filter"));
          nd.delete(N("DecodeParms"));
          nd.delete(N("Length"));
          doc.context.assign(ref, doc.context.flateStream(raw, Object.fromEntries([...nd.entries()].map(([k, v]) => [k.asString().slice(1), v]))));
        } catch {
          /* left for the validator to report */
        }
      }
    }
  }
}

// ── Main

// Whether a PDF/A conversion at this level will have to render any page as an
// image, which is when the resolution and text-layer options matter.
export async function pdfaNeedsRaster(file: Blob, level: PdfaLevel): Promise<boolean> {
  const doc = await PDFDocument.load(new Uint8Array(await file.arrayBuffer()), { updateMetadata: false });
  return (await fixForPdfA(doc, level, true)).raster.size > 0;
}

// Files larger than this aren't opened just to decide whether to show the render options.
export const PDFA_PREFLIGHT_MAX = 50 * 1024 * 1024;

// Whether any of the files needs the render options: one file at a time, so only one
// is in memory, stopping at the first that does. Undefined when live() turns false.
export async function pdfaPreflight(files: Blob[], level: PdfaLevel, live: () => boolean = () => true): Promise<boolean | undefined> {
  for (const file of files) {
    if (!live()) return undefined;
    if (file.size > PDFA_PREFLIGHT_MAX) return true;
    const needs = await pdfaNeedsRaster(file, level).catch(() => true);
    if (!live()) return undefined;
    if (needs) return true;
  }
  return false;
}

// scanOnly: only find the pages that must be rendered; the document isn't cleaned
// and no font is embedded (what pdfaNeedsRaster needs, at a fraction of the work).
export async function fixForPdfA(doc: PDFDocument, level: PdfaLevel = "2b", scanOnly = false): Promise<PdfaReport> {
  const c = { doc };
  const part = Number(level[0]);
  const removed = new Set<string>();
  const raster = new Set<number>();
  const substituted = new Map<string, string>();
  if (!scanOnly) cleanDocument(doc, removed, part);

  // Per page: annotations, then everything the page draws.
  const fontPages = new Map<PDFDict, Set<number>>();
  const allCodes = new Map<PDFDict, Set<number>>();
  doc.getPages().forEach((page, i) => {
    const node = page.node;
    node.delete(N("AA"));
    node.delete(N("PresSteps"));
    const group = node.lookupMaybe(N("Group"), PDFDict);
    if (group && cmykSpace(group.get(N("CS")), undefined, c)) group.set(N("CS"), N("DeviceRGB"));
    // PDF/A-1 forbids the page group; a page that really is transparent is rendered.
    if (part === 1) node.delete(N("Group"));
    const u: Usage = { cmyk: false, postscript: false, transparency: false, jpx: false, fonts: new Map() };
    const seen = new Set<PDFObject>();
    let resources: PDFDict | undefined;
    for (let n: PDFDict | undefined = node; n && !resources; n = n.lookupMaybe(N("Parent"), PDFDict)) resources = n.lookupMaybe(N("Resources"), PDFDict);

    const annots = node.lookupMaybe(N("Annots"), PDFArray);
    if (annots) {
      const keep: PDFObject[] = [];
      for (const ref of annots.asArray()) {
        const a = doc.context.lookup(ref);
        if (!(a instanceof PDFDict)) continue;
        const sub = String(a.get(N("Subtype")));
        if (BAD_ANNOTS.has(sub)) { removed.add(`${sub.slice(1)} annotations`); continue; }
        if (part === 1) {
          // Newer annotation types and faded annotations: drawn into the page if they have a look, dropped if not.
          const ca = a.lookup(N("CA"));
          if (!PDF14_ANNOTS.has(sub) && !a.has(N("AP"))) { removed.add(`${sub.slice(1)} annotations`); continue; }
          if (!PDF14_ANNOTS.has(sub) || (ca instanceof PDFNumber && ca.asNumber() < 1)) raster.add(i);
        }
        a.delete(N("AA"));
        if (badAction(a.get(N("A")), c)) { a.delete(N("A")); removed.add("annotation actions"); }
        // Printable, not hidden.
        const f = a.lookup(N("F"));
        const flags = f instanceof PDFNumber ? f.asNumber() : 0;
        a.set(N("F"), PDFNumber.of((flags | 4) & ~(1 | 2 | 32 | 256)));
        const ap = a.lookupMaybe(N("AP"), PDFDict);
        if (!ap && sub !== "/Link" && sub !== "/Popup") {
          // A form field with no look of its own: render the page instead. Notes without one are dropped.
          if (sub === "/Widget") raster.add(i);
          else { removed.add("annotations without appearances"); continue; }
        }
        if (ap) {
          ap.delete(N("D"));
          ap.delete(N("R"));
          const normal = ap.lookup(N("N"));
          const streams = normal instanceof PDFRawStream ? [normal] : normal instanceof PDFDict ? normal.values().map((v) => doc.context.lookup(v)) : [];
          for (const s of streams)
            if (s instanceof PDFRawStream && !seen.has(s)) {
              seen.add(s);
              scan(contentBytes(s, doc), s.dict.lookupMaybe(N("Resources"), PDFDict) ?? resources, u, c, seen);
            }
        }
        keep.push(ref);
      }
      node.set(N("Annots"), doc.context.obj(keep));
    }

    scan(contentBytes(node.get(N("Contents")), doc), resources, u, c, seen);
    if (u.cmyk || u.postscript || (part === 1 && (u.transparency || u.jpx))) raster.add(i);
    for (const [font, codes] of u.fonts) {
      fontPages.set(font, (fontPages.get(font) ?? new Set()).add(i));
      const all = allCodes.get(font) ?? new Set<number>();
      codes.forEach((b) => all.add(b));
      allCodes.set(font, all);
    }
  });

  // Fonts: embedded ones lose CharSet/CIDSet (often wrong, and optional in PDF/A-2);
  // unembedded simple fonts get a stand-in; anything else renders its pages as images.
  for (const [font, codes] of allCodes) {
    const pages = fontPages.get(font)!;
    const sub = String(font.get(N("Subtype")));
    if (sub === "/Type3") continue;
    const fail = () => pages.forEach((p) => raster.add(p));
    if (sub === "/Type0") {
      const desc = font.lookupMaybe(N("DescendantFonts"), PDFArray)?.lookup(0, PDFDict)?.lookupMaybe(N("FontDescriptor"), PDFDict);
      // PDF/A-1 requires CIDSet and CharSet for subsets; PDF/A-2 makes them optional, and wrong ones fail.
      if (part > 1) desc?.delete(N("CIDSet"));
      if (!embeddedFile(desc)) fail();
      continue;
    }
    const desc = font.lookupMaybe(N("FontDescriptor"), PDFDict);
    if (embeddedFile(desc)) {
      if (part > 1) desc!.delete(N("CharSet"));
      continue;
    }
    const base = String(font.get(N("BaseFont")) ?? "/").slice(1).replace(/^[A-Z]{6}\+/, "");
    const flagsObj = desc?.lookup(N("Flags"));
    const flags = flagsObj instanceof PDFNumber ? flagsObj.asNumber() : 0;
    if (/symbol|dingbat|wingding|webding/i.test(base)) { fail(); continue; }
    const drawn = encodingOf(font, sub === "/Type1" && !desc);
    if (!drawn) { fail(); continue; }
    const bold = /bold|black|heavy|semibold|demi/i.test(base) || !!(flags & 262144);
    const italic = /italic|oblique/i.test(base) || !!(flags & 64);
    let face: Face;
    try {
      face = await loadFace(pickFamily(base, flags), bold, italic);
    } catch {
      fail();
      continue;
    }
    const kit = face.font;
    // Every character drawn needs a glyph in the stand-in.
    const missing = [...codes].some((code) => {
      const cp = unicodeOf(drawn[code]);
      if (cp === undefined) return code >= 32;
      return cp !== 0x20 && cp !== 0xa0 && !kit.hasGlyphForCodePoint(cp);
    });
    if (missing) { fail(); continue; }
    if (scanOnly) continue;

    // PDF/A-1: a non-symbolic TrueType font names WinAnsi or MacRoman, with no Differences
    // (ISO 19005-1, 6.3.7). When the codes drawn mean what WinAnsi says they mean, it is
    // WinAnsi; otherwise the stand-in is symbolic, its cmap built for the codes.
    const symbolic = part === 1 && [...codes].some((code) => drawn[code] !== WIN_ANSI[code]);
    const enc = part === 1 && !symbolic ? WIN_ANSI : drawn;

    const scale = 1000 / kit.unitsPerEm;
    const widths = Array.from({ length: 256 }, (_, code) => {
      const cp = unicodeOf(enc[code]);
      return cp !== undefined && kit.hasGlyphForCodePoint(cp) ? Math.round(kit.glyphForCodePoint(cp).advanceWidth * scale) : 0;
    });
    const ctx = doc.context;
    const unicode = new Map<number, number>();
    enc.forEach((g, code) => {
      const cp = unicodeOf(g);
      if (cp !== undefined && kit.hasGlyphForCodePoint(cp)) unicode.set(code, cp);
    });
    const program = symbolic ? withSymbolicCmap(face.sfnt, new Map([...unicode].map(([code, cp]) => [code, kit.glyphForCodePoint(cp).id]))) : face.sfnt;
    const fontFile = ctx.flateStream(program, { Length1: program.length });
    const name = kit.postscriptName ?? `${face.family}-${bold ? "Bold" : "Regular"}`;
    const descriptor = ctx.obj({
      Type: "FontDescriptor",
      FontName: N(name),
      Flags: (symbolic ? 4 : 32) | (face.family === "cousine" ? 1 : 0) | (face.family === "tinos" || face.family === "caladea" ? 2 : 0) | (italic ? 64 : 0),
      FontBBox: [kit.bbox.minX, kit.bbox.minY, kit.bbox.maxX, kit.bbox.maxY].map((v) => Math.round(v * scale)),
      ItalicAngle: kit.italicAngle,
      Ascent: Math.round(kit.ascent * scale),
      Descent: Math.round(kit.descent * scale),
      CapHeight: Math.round((kit.capHeight || kit.ascent * 0.7) * scale),
      StemV: bold ? 140 : 80,
      FontFile2: ctx.register(fontFile),
    });
    // Non-symbolic TrueType: WinAnsi plus Differences for every code that maps elsewhere.
    const diffs: (number | PDFName)[] = [];
    let prev = -2;
    for (let code = 0; code < 256; code++) {
      if (!enc[code] || enc[code] === WIN_ANSI[code]) continue;
      if (code !== prev + 1) diffs.push(code); // a run of changed codes starts with its first code
      diffs.push(N(enc[code]!));
      prev = code;
    }
    font.set(N("Subtype"), N("TrueType"));
    font.set(N("BaseFont"), N(name));
    font.set(N("FirstChar"), PDFNumber.of(0));
    font.set(N("LastChar"), PDFNumber.of(255));
    font.set(N("Widths"), ctx.obj(widths));
    font.set(N("FontDescriptor"), ctx.register(descriptor));
    if (symbolic) {
      // A symbolic TrueType font has no Encoding; text keeps its meaning through ToUnicode.
      font.delete(N("Encoding"));
      if (!font.has(N("ToUnicode"))) font.set(N("ToUnicode"), ctx.register(ctx.flateStream(toUnicodeCMap(unicode))));
    } else font.set(N("Encoding"), diffs.length ? ctx.obj({ Type: "Encoding", BaseEncoding: "WinAnsiEncoding", Differences: diffs }) : N("WinAnsiEncoding"));
    substituted.set(base, name);
  }

  // The u levels: every character on a page kept as it is maps to Unicode, or
  // the file comes down to the b level of the same part.
  let reached = level;
  if (level.endsWith("u")) {
    for (const [font, codes] of allCodes)
      if ([...fontPages.get(font)!].some((p) => !raster.has(p)) && !mapsToUnicode(font, codes, doc)) reached = `${part}b` as PdfaLevel;
  }

  return { raster, substituted, removed, level: reached };
}

// PDF/A-1 is based on PDF 1.4, PDF/A-2 and 3 on PDF 1.7. pdf-lib always
// writes a 1.7 header, so the saved file's version digit is set here; the
// header keeps its length, so every offset stays right.
export function pdfaVersion(bytes: Uint8Array, level: PdfaLevel): Uint8Array {
  if (level[0] === "1" && new TextDecoder().decode(bytes.subarray(0, 8)) === "%PDF-1.7") bytes[7] = 0x34;
  return bytes;
}

// code → Unicode text, from a ToUnicode CMap's bfchar and bfrange entries.
function toUnicodeMap(font: PDFDict, doc: PDFDocument): Map<number, string> | undefined {
  const streams = contentBytes(font.get(N("ToUnicode")), doc);
  if (!streams.length) return undefined;
  const map = new Map<number, string>();
  const int = (b: Uint8Array) => b.reduce((n, x) => n * 256 + x, 0);
  const text = (b: Uint8Array) => String.fromCharCode(...Array.from({ length: b.length >> 1 }, (_, i) => (b[2 * i] << 8) | b[2 * i + 1]));
  let operands: (Uint8Array | "[" | "]")[] = [];
  for (const bytes of streams)
    for (const t of tokens(bytes)) {
      if ("str" in t) operands.push(t.str);
      else if ("mark" in t && (t.mark === "[" || t.mark === "]")) operands.push(t.mark);
      else if ("op" in t) {
        if (t.op === "endbfchar")
          for (let i = 0; i + 1 < operands.length; i += 2) {
            const [src, dst] = operands.slice(i, i + 2);
            if (src instanceof Uint8Array && dst instanceof Uint8Array) map.set(int(src), text(dst));
          }
        if (t.op === "endbfrange")
          for (let i = 0; i + 2 < operands.length; ) {
            const [lo, hi, dst] = operands.slice(i, i + 3);
            if (!(lo instanceof Uint8Array) || !(hi instanceof Uint8Array)) break;
            const from = int(lo), to = Math.min(int(hi), from + 65535);
            if (dst instanceof Uint8Array) {
              // The last character of the destination counts up across the range.
              const base = text(dst);
              for (let c = from; c <= to; c++) map.set(c, base.slice(0, -1) + String.fromCharCode(base.charCodeAt(base.length - 1) + c - from));
              i += 3;
            } else if (dst === "[") {
              let j = i + 3;
              for (let c = from; j < operands.length && operands[j] !== "]"; j++, c++) {
                const d = operands[j];
                if (d instanceof Uint8Array && c <= to) map.set(c, text(d));
              }
              i = j + 1;
            } else break;
          }
        operands = [];
      }
    }
  return map;
}

// Unicode for every code drawn, from the ToUnicode map, or else from glyph names
// Unicode knows (ISO 19005-2, 6.2.11.7.2); a code mapped to U+0000, U+FEFF or
// U+FFFE doesn't count. Composite fonts, symbolic fonts and built-in encodings need the map.
function mapsToUnicode(font: PDFDict, codes: Set<number>, doc: PDFDocument): boolean {
  const map = toUnicodeMap(font, doc);
  const mapped = (code: number) => {
    const t = map?.get(code);
    return !!t && t !== "\u0000" && t !== "\ufeff" && t !== "\ufffe";
  };
  const sub = String(font.get(N("Subtype")));
  if (sub === "/Type0") {
    if (!map) return false;
    // Only Identity codes are known here; with any other CMap the map is taken as it is.
    const enc = font.get(N("Encoding"));
    return enc === N("Identity-H") || enc === N("Identity-V") ? [...codes].every(mapped) : true;
  }
  const desc = font.lookupMaybe(N("FontDescriptor"), PDFDict);
  const flags = desc?.lookup(N("Flags"));
  const named =
    (sub === "/Type3" || !(flags instanceof PDFNumber && flags.asNumber() & 4)) && (sub === "/Type3" || !embeddedFile(desc) || font.has(N("Encoding")))
      ? encodingOf(font, sub === "/Type1" && !embeddedFile(desc))
      : null;
  return [...codes].every((code) => mapped(code) || (!!named && unicodeOf(named[code]) !== undefined));
}
