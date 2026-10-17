// PDF → PDF/A-2b that keeps the pages as they are, the way Ghostscript and
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

import "regenerator-runtime/runtime";
import fontkit from "@pdf-lib/fontkit";
import { unzlibSync } from "fflate";
import {
  PDFArray, PDFDict, PDFHeader, PDFName, PDFNumber, PDFRawStream, PDFRef, PDFStream, decodePDFRawStream,
  type PDFDocument, type PDFObject,
} from "pdf-lib";
import { VENDOR } from "../vendor";
import { contentBytes, tokens } from "./content";
import { STANDARD, WIN_ANSI, unicodeOf, type Encoding } from "./encodings";

// Tests read the files from disk instead.
export const pdfaFonts = {
  load: async (file: string): Promise<Uint8Array> => new Uint8Array(await (await fetch(`${VENDOR}pdfa-fonts/${file}`)).arrayBuffer()),
};

export type PdfaReport = { raster: Set<number>; substituted: Map<string, string>; removed: Set<string> };

const N = (s: string) => PDFName.of(s);

// ── Fonts

// WOFF 1.0 → plain OpenType/TrueType (what a PDF embeds).
function woffToSfnt(w: Uint8Array): Uint8Array {
  const v = new DataView(w.buffer, w.byteOffset, w.byteLength);
  const count = v.getUint16(12);
  const tables = Array.from({ length: count }, (_, i) => {
    const e = 44 + i * 20;
    const offset = v.getUint32(e + 4), comp = v.getUint32(e + 8), orig = v.getUint32(e + 12);
    const raw = w.subarray(offset, offset + comp);
    return { tag: v.getUint32(e), checksum: v.getUint32(e + 16), data: comp < orig ? unzlibSync(raw) : raw };
  });
  const pad = (n: number) => (n + 3) & ~3;
  const size = 12 + 16 * count + tables.reduce((s, t) => s + pad(t.data.length), 0);
  const out = new Uint8Array(size);
  const o = new DataView(out.buffer);
  const log = Math.floor(Math.log2(count));
  o.setUint32(0, v.getUint32(4));
  o.setUint16(4, count);
  o.setUint16(6, 16 * 2 ** log);
  o.setUint16(8, log);
  o.setUint16(10, count * 16 - 16 * 2 ** log);
  let at = 12 + 16 * count;
  tables.forEach((t, i) => {
    o.setUint32(12 + i * 16, t.tag);
    o.setUint32(16 + i * 16, t.checksum);
    o.setUint32(20 + i * 16, at);
    o.setUint32(24 + i * 16, t.data.length);
    out.set(t.data, at);
    at += pad(t.data.length);
  });
  return out;
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

type Usage = { cmyk: boolean; postscript: boolean; fonts: Map<PDFDict, Set<number>> };

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
    for (const b of s) set.add(b);
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
    }
  }
  for (const [, g] of resources?.lookupMaybe(N("ExtGState"), PDFDict)?.entries() ?? []) {
    const gs = c.doc.context.lookup(g);
    const smask = gs instanceof PDFDict ? gs.lookup(N("SMask")) : undefined;
    const group = smask instanceof PDFDict ? smask.lookup(N("G")) : undefined;
    if (group instanceof PDFRawStream) form(group);
  }
}

// ── Document clean-up

const BAD_ACTIONS = new Set(["/Launch", "/Sound", "/Movie", "/ResetForm", "/ImportData", "/JavaScript", "/Hide", "/SetOCGState", "/Rendition", "/Trans", "/GoTo3DView", "/GoToE"]);
const GOOD_NAMED = new Set(["/NextPage", "/PrevPage", "/FirstPage", "/LastPage"]);
const BAD_ANNOTS = new Set(["/Sound", "/Movie", "/Screen", "/3D", "/RichMedia", "/FileAttachment"]);

function badAction(a: PDFObject | undefined, c: Ctx): boolean {
  const d = a instanceof PDFRef ? c.doc.context.lookup(a) : a;
  if (!(d instanceof PDFDict)) return false;
  const s = String(d.get(N("S")));
  if (BAD_ACTIONS.has(s)) return true;
  if (s === "/Named") return !GOOD_NAMED.has(String(d.get(N("N"))));
  return badAction(d.get(N("Next")), c);
}

function cleanDocument(doc: PDFDocument, removed: Set<string>) {
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
  if (badAction(cat.get(N("OpenAction")), c)) drop(cat, "OpenAction", "open action");
  const names = cat.lookupMaybe(N("Names"), PDFDict);
  if (names) {
    drop(names, "JavaScript", "scripts");
    drop(names, "EmbeddedFiles", "attachments");
    drop(names, "AlternatePresentations", "alternate presentations");
  }
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

export async function fixForPdfA(doc: PDFDocument): Promise<PdfaReport> {
  const c = { doc };
  const removed = new Set<string>();
  const raster = new Set<number>();
  const substituted = new Map<string, string>();
  cleanDocument(doc, removed);

  // Per page: annotations, then everything the page draws.
  const fontPages = new Map<PDFDict, Set<number>>();
  const allCodes = new Map<PDFDict, Set<number>>();
  doc.getPages().forEach((page, i) => {
    const node = page.node;
    node.delete(N("AA"));
    node.delete(N("PresSteps"));
    const group = node.lookupMaybe(N("Group"), PDFDict);
    if (group && cmykSpace(group.get(N("CS")), undefined, c)) group.set(N("CS"), N("DeviceRGB"));
    const u: Usage = { cmyk: false, postscript: false, fonts: new Map() };
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
    if (u.cmyk || u.postscript) raster.add(i);
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
      desc?.delete(N("CIDSet"));
      if (!embeddedFile(desc)) fail();
      continue;
    }
    const desc = font.lookupMaybe(N("FontDescriptor"), PDFDict);
    if (embeddedFile(desc)) {
      desc!.delete(N("CharSet"));
      continue;
    }
    const base = String(font.get(N("BaseFont")) ?? "/").slice(1).replace(/^[A-Z]{6}\+/, "");
    const flagsObj = desc?.lookup(N("Flags"));
    const flags = flagsObj instanceof PDFNumber ? flagsObj.asNumber() : 0;
    if (/symbol|dingbat|wingding|webding/i.test(base)) { fail(); continue; }
    const enc = encodingOf(font, sub === "/Type1" && !desc);
    if (!enc) { fail(); continue; }
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
      const cp = unicodeOf(enc[code]);
      if (cp === undefined) return code >= 32;
      return cp !== 0x20 && cp !== 0xa0 && !kit.hasGlyphForCodePoint(cp);
    });
    if (missing) { fail(); continue; }

    const scale = 1000 / kit.unitsPerEm;
    const widths = Array.from({ length: 256 }, (_, code) => {
      const cp = unicodeOf(enc[code]);
      return cp !== undefined && kit.hasGlyphForCodePoint(cp) ? Math.round(kit.glyphForCodePoint(cp).advanceWidth * scale) : 0;
    });
    const ctx = doc.context;
    const fontFile = ctx.flateStream(face.sfnt, { Length1: face.sfnt.length });
    const name = kit.postscriptName ?? `${face.family}-${bold ? "Bold" : "Regular"}`;
    const descriptor = ctx.obj({
      Type: "FontDescriptor",
      FontName: N(name),
      Flags: 32 | (face.family === "cousine" ? 1 : 0) | (face.family === "tinos" || face.family === "caladea" ? 2 : 0) | (italic ? 64 : 0),
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
    font.set(N("Encoding"), diffs.length ? ctx.obj({ Type: "Encoding", BaseEncoding: "WinAnsiEncoding", Differences: diffs }) : N("WinAnsiEncoding"));
    substituted.set(base, name);
  }

  // PDF/A-2 is based on PDF 1.7.
  const header = doc.context.header.toString();
  if (!/%PDF-1\.[0-7]/.test(header)) doc.context.header = PDFHeader.forVersion(1, 7);
  return { raster, substituted, removed };
}
