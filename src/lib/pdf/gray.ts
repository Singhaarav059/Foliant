"use client";

// Greyscale (P2-10): every colour in the file becomes a grey of the same
// lightness. Written from the PDF specification (ISO 32000-1 §8.6):
//   content   rg/RG and k/K become g/G; cs/CS to a colour space with 3 or 4
//             components (device, ICC, CalRGB, Lab) or a Separation with a
//             type 2 tint function becomes /DeviceGray, and sc/scn follow
//   images    decoded and stored grey; palettes get a grey base instead
//   shadings  type 2 and 3 functions and 8-bit sampled ones recomputed grey
//   the rest  annotation colours, appearance streams, patterns, Type 3
//             glyphs, transparency groups and form field defaults
// What can't be read (JPEG 2000 images, PostScript functions, mesh
// shadings) is left as it is, and the note says how many.

import { PDFArray, PDFDict, PDFHexString, PDFName, PDFNumber, PDFRawStream, PDFRef, PDFStream, PDFString, type PDFContext, type PDFDocument, type PDFObject } from "pdf-lib";
import { unzlibSync, zlibSync } from "fflate";
import { baseName, bytesOf, pdfBlob, yieldToPage, type Output, type Progress } from "./common";
import { contentBytes, tokens, type Token } from "./content";
import { openForEdit } from "./open";
import { colourOf, filterNames, inflate, num, readImage } from "./optimize";
import { encodeJpeg } from "./jpeg";
import { runQpdf } from "./qpdf";
import { luma, predictPng } from "./pixels";

const N = (s: string) => PDFName.of(s);
const GRAY = N("DeviceGray");
const clamp = (v: number) => Math.min(1, Math.max(0, v));
// Rec. 601 luma, as most viewers use for "print in greyscale".
export const rgbToGray = (r: number, g: number, b: number) => clamp(0.299 * r + 0.587 * g + 0.114 * b);
export const cmykToGray = (c: number, m: number, y: number, k: number) => clamp(1 - Math.min(1, 0.3 * c + 0.59 * m + 0.11 * y + k));
const fmt = (v: number) => String(Math.round(v * 1000) / 1000);

// What sc/scn mean in the current colour space: how many operands and how to
// turn them into a grey; null when the space is kept (grey, palette, pattern).
type Space = { n: number; toGray: ((v: number[]) => number) | null; pattern?: Space | null };
const DEVICE: Record<string, Space> = {
  DeviceGray: { n: 1, toGray: null },
  DeviceRGB: { n: 3, toGray: (v) => rgbToGray(v[0], v[1], v[2]) },
  DeviceCMYK: { n: 4, toGray: (v) => cmykToGray(v[0], v[1], v[2], v[3]) },
  // Abbreviations allowed in inline images.
  G: { n: 1, toGray: null }, RGB: { n: 3, toGray: (v) => rgbToGray(v[0], v[1], v[2]) }, CMYK: { n: 4, toGray: (v) => cmykToGray(v[0], v[1], v[2], v[3]) },
};

class Greyer {
  ctx: PDFContext;
  done = new Set<PDFObject>();
  left = 0;
  constructor(public doc: PDFDocument) {
    this.ctx = doc.context;
  }
  look(o: PDFObject | undefined) {
    return o instanceof PDFRef ? this.ctx.lookup(o) : o;
  }
  once(o: PDFObject | undefined) {
    if (!o || this.done.has(o)) return false;
    this.done.add(o);
    return true;
  }

  // A colour space object (resolved from a resource or written inline).
  space(cs: PDFObject | undefined, depth = 0): Space | null {
    cs = this.look(cs);
    if (cs instanceof PDFName) return DEVICE[cs.decodeText()] ?? (cs.decodeText() === "Pattern" ? { n: 0, toGray: null, pattern: null } : null);
    if (!(cs instanceof PDFArray) || depth > 3) return null;
    const kind = String(cs.get(0)).slice(1);
    if (kind === "ICCBased" || kind === "CalRGB" || kind === "CalGray") {
      const n = kind === "CalRGB" ? 3 : kind === "CalGray" ? 1 : num((this.look(cs.get(1)) as PDFRawStream | undefined)?.dict ?? this.ctx.obj({}), "N");
      return n === 1 ? DEVICE.DeviceGray : n === 3 ? DEVICE.DeviceRGB : n === 4 ? DEVICE.DeviceCMYK : null;
    }
    if (kind === "Lab") return { n: 3, toGray: (v) => clamp(v[0] / 100) };
    if (kind === "Indexed") return { n: 1, toGray: null };
    if (kind === "Pattern") return { n: 0, toGray: null, pattern: cs.size() > 1 ? this.space(cs.get(1), depth + 1) : null };
    if (kind === "Separation" || kind === "DeviceN") {
      const fn = this.look(cs.get(3));
      const alt = this.space(cs.get(2), depth + 1);
      const names = this.look(cs.get(1));
      const n = kind === "Separation" ? 1 : names instanceof PDFArray ? names.size() : 0;
      const f = fn instanceof PDFDict || fn instanceof PDFStream ? this.fn(fn, alt) : null;
      return n === 1 && f ? { n: 1, toGray: (v) => f(v[0]) } : null;
    }
    return null;
  }

  // A type 2 function from one input to the alternate space, as a grey.
  fn(fn: PDFDict | PDFStream, alt: Space | null): ((t: number) => number) | null {
    const d = fn instanceof PDFStream ? fn.dict : fn;
    if (num(d, "FunctionType") !== 2) return null;
    const arr = (k: string, dflt: number[]) => {
      const a = this.look(d.get(N(k)));
      return a instanceof PDFArray ? a.asArray().map((x) => (this.look(x) as PDFNumber)?.asNumber?.() ?? 0) : dflt;
    };
    const c0 = arr("C0", [0]), c1 = arr("C1", [1]), e = num(d, "N") ?? 1;
    const g = (c: number[]) => (c.length === 1 ? (alt?.n === 1 ? c[0] : 1 - c[0]) : alt?.toGray && c.length === alt.n ? alt.toGray(c) : null);
    const g0 = g(c0), g1 = g(c1);
    if (g0 === null || g1 === null) return null;
    return (t) => clamp(g0 + Math.pow(clamp(t), e) * (g1 - g0));
  }

  // ── Resources: the colour spaces they name, and everything they draw.
  resources(res: PDFObject | undefined) {
    const r = this.look(res);
    if (!(r instanceof PDFDict) || !this.once(r)) return;
    const each = (key: string, fn: (v: PDFObject) => void) => {
      const d = this.look(r.get(N(key)));
      if (d instanceof PDFDict) for (const [, v] of d.entries()) fn(v);
    };
    each("ColorSpace", (v) => this.spaceObject(v));
    each("XObject", (v) => this.xobject(v, r));
    each("Pattern", (v) => this.pattern(v, r));
    each("Shading", (v) => this.shading(v));
    each("Font", (v) => this.type3(v, r));
    each("ExtGState", (v) => {
      const gs = this.look(v);
      const mask = gs instanceof PDFDict ? this.look(gs.get(N("SMask"))) : undefined;
      if (mask instanceof PDFDict) this.xobject(mask.get(N("G")), r);
    });
  }

  // Palettes and Pattern bases change in place, so every use of them turns grey.
  spaceObject(v: PDFObject) {
    const cs = this.look(v);
    if (!(cs instanceof PDFArray) || !this.once(cs)) return;
    const kind = String(cs.get(0));
    if (kind === "/Indexed") this.palette(cs);
    if (kind === "/Pattern" && cs.size() > 1) {
      const base = this.space(cs.get(1));
      if (base?.toGray || base?.n === 1) cs.set(1, GRAY);
    }
  }

  palette(cs: PDFArray) {
    const base = this.space(cs.get(1));
    const colour = colourOf(this.ctx, cs, false);
    if (!base || base.n === 1 && !base.toGray) return;
    if (!base.toGray || !colour?.palette) return void this.left++;
    const { lookup, hival } = colour.palette;
    const n = base.n;
    const out = new Uint8Array(hival + 1);
    for (let i = 0; i <= hival; i++) out[i] = Math.round(base.toGray(Array.from({ length: n }, (_, k) => (lookup[i * n + k] ?? 0) / 255)) * 255);
    cs.set(1, GRAY);
    cs.set(3, PDFHexString.of([...out].map((b) => b.toString(16).padStart(2, "0")).join("")));
  }

  xobject(v: PDFObject | undefined, parent: PDFDict | undefined) {
    const x = this.look(v);
    if (!(x instanceof PDFRawStream) || this.done.has(x)) return;
    const sub = String(x.dict.get(N("Subtype")));
    if (sub === "/Image") return this.image(v as PDFRef, x);
    // Forms, and appearance streams, which may leave out /Subtype.
    if (sub === "/Form" || x.dict.has(N("BBox"))) this.form(v, x, parent);
  }

  // A form XObject, pattern or appearance: its content and its resources.
  form(ref: PDFObject | undefined, x: PDFRawStream, parent: PDFDict | undefined) {
    if (!this.once(x)) return;
    const own = this.look(x.dict.get(N("Resources")));
    const res = own instanceof PDFDict ? own : parent;
    this.resources(res);
    this.group(x.dict);
    const out = this.content(contentBytes(x, this.doc), res);
    if (out) this.replace(ref, x, out);
  }

  // A transparency group's blending space.
  group(d: PDFDict) {
    const g = this.look(d.get(N("Group")));
    if (g instanceof PDFDict && g.has(N("CS"))) g.set(N("CS"), GRAY);
  }

  pattern(v: PDFObject, parent: PDFDict) {
    const p = this.look(v);
    const d = p instanceof PDFStream ? p.dict : p instanceof PDFDict ? p : null;
    if (!d) return;
    if (num(d, "PatternType") === 2) this.shading(d.get(N("Shading")));
    else if (p instanceof PDFRawStream) this.form(v, p, parent);
  }

  type3(v: PDFObject, parent: PDFDict) {
    const f = this.look(v);
    if (!(f instanceof PDFDict) || String(f.get(N("Subtype"))) !== "/Type3" || !this.once(f)) return;
    const own = this.look(f.get(N("Resources")));
    const res = own instanceof PDFDict ? own : parent;
    this.resources(res);
    const procs = this.look(f.get(N("CharProcs")));
    if (!(procs instanceof PDFDict)) return;
    for (const [, ref] of procs.entries()) {
      const s = this.look(ref);
      if (!(s instanceof PDFRawStream) || !this.once(s)) continue;
      const out = this.content(contentBytes(s, this.doc), res);
      if (out) this.replace(ref, s, out);
    }
  }

  shading(v: PDFObject | undefined) {
    const s = this.look(v);
    const d = s instanceof PDFStream ? s.dict : s instanceof PDFDict ? s : null;
    if (!d || !this.once(d)) return;
    const space = this.space(d.get(N("ColorSpace")));
    if (!space || (space.n === 1 && !space.toGray)) return;
    const type = num(d, "ShadingType") ?? 0;
    const f = this.look(d.get(N("Function")));
    const conv = type >= 1 && type <= 3 && f ? this.recolourFunction(f, space) : null;
    if (!space.toGray || !conv) return void this.left++;
    d.set(N("Function"), conv);
    d.set(N("ColorSpace"), GRAY);
    const bg = this.look(d.get(N("Background")));
    if (bg instanceof PDFArray) d.set(N("Background"), this.ctx.obj([this.grayOf(bg, space)]));
  }

  grayOf(a: PDFArray, space: Space) {
    const v = a.asArray().map((x) => (this.look(x) as PDFNumber)?.asNumber?.() ?? 0);
    return space.toGray && v.length === space.n ? space.toGray(v) : v[0] ?? 0;
  }

  // A shading's function with grey output: type 2 (C0, C1), type 3 of those,
  // and 8-bit sampled (type 0) ones. An array of n one-output functions only
  // when all are type 2.
  recolourFunction(f: PDFObject, space: Space): PDFObject | null {
    const g = space.toGray!;
    const nums = (d: PDFDict, k: string) => {
      const a = this.look(d.get(N(k)));
      return a instanceof PDFArray ? a.asArray().map((x) => (this.look(x) as PDFNumber)?.asNumber?.() ?? 0) : null;
    };
    if (f instanceof PDFArray) {
      const parts = f.asArray().map((x) => this.look(x));
      if (parts.length !== space.n || !parts.every((p) => p instanceof PDFDict && num(p, "FunctionType") === 2)) return null;
      const ds = parts as PDFDict[];
      const e = num(ds[0], "N") ?? 1;
      if (!ds.every((d) => (num(d, "N") ?? 1) === e)) return null;
      const c0 = ds.map((d) => nums(d, "C0")?.[0] ?? 0), c1 = ds.map((d) => nums(d, "C1")?.[0] ?? 1);
      return this.ctx.obj({ FunctionType: 2, Domain: ds[0].get(N("Domain")) ?? [0, 1], C0: [g(c0)], C1: [g(c1)], N: e });
    }
    const d = f instanceof PDFStream ? f.dict : f instanceof PDFDict ? f : null;
    if (!d) return null;
    const type = num(d, "FunctionType");
    if (type === 2) {
      const c0 = nums(d, "C0") ?? Array(space.n).fill(0), c1 = nums(d, "C1") ?? Array(space.n).fill(1);
      if (c0.length !== space.n || c1.length !== space.n) return null;
      const nd = d.clone(this.ctx);
      nd.set(N("C0"), this.ctx.obj([g(c0)]));
      nd.set(N("C1"), this.ctx.obj([g(c1)]));
      nd.delete(N("Range"));
      return this.ctx.register(nd);
    }
    if (type === 3) {
      const fs = this.look(d.get(N("Functions")));
      if (!(fs instanceof PDFArray)) return null;
      const subs = fs.asArray().map((x) => this.recolourFunction(this.look(x)!, space));
      if (subs.some((x) => !x)) return null;
      const nd = d.clone(this.ctx);
      nd.set(N("Functions"), this.ctx.obj(subs as PDFObject[]));
      nd.delete(N("Range"));
      return this.ctx.register(nd);
    }
    if (type === 0 && f instanceof PDFRawStream && num(d, "BitsPerSample") === 8) {
      const range = nums(d, "Range");
      const size = nums(d, "Size");
      const raw = inflate(f, 16 << 20);
      if (!range || range.length !== space.n * 2 || !size || !raw || d.has(N("Decode"))) return null;
      const count = size.reduce((a, b) => a * b, 1);
      if (raw.length < count * space.n) return null;
      const out = new Uint8Array(count);
      for (let i = 0; i < count; i++) {
        const v = Array.from({ length: space.n }, (_, k) => range[2 * k] + (raw[i * space.n + k] / 255) * (range[2 * k + 1] - range[2 * k]));
        out[i] = Math.round(g(v) * 255);
      }
      const nd = d.clone(this.ctx);
      for (const k of ["Filter", "DecodeParms", "Length"]) nd.delete(N(k));
      nd.set(N("Range"), this.ctx.obj([0, 1]));
      nd.set(N("Filter"), N("FlateDecode"));
      return this.ctx.register(PDFRawStream.of(nd, zlibSync(out)));
    }
    return null;
  }

  // ── Images
  image(ref: PDFRef, x: PDFRawStream) {
    this.done.add(x);
    const d = x.dict;
    if (d.get(N("ImageMask"))?.toString() === "true") return;
    const csObj = d.get(N("ColorSpace"));
    const cs = this.look(csObj);
    if (cs instanceof PDFArray && String(cs.get(0)) === "/Indexed") return this.palette(cs);
    const space = this.space(csObj);
    if (space && space.n === 1 && !space.toGray) return;
    this.images.push([ref, x]);
  }
  images: [PDFRef, PDFRawStream][] = [];

  async convertImages(progress?: Progress) {
    let k = 0;
    for (const [ref, x] of this.images) {
      progress?.(++k, this.images.length);
      await yieldToPage();
      const d = x.dict;
      const w = num(d, "Width"), h = num(d, "Height");
      const colour = colourOf(this.ctx, d.get(N("ColorSpace")));
      let px = w && h && colour ? await readImage(x, w, h, colour).catch(() => null) : null;
      if (!px) { this.left++; continue; }
      if (px.ch === 4) {
        const out = new Uint8Array(px.w * px.h);
        for (let i = 0; i < out.length; i++) out[i] = Math.round(cmykToGray(px.data[i * 4] / 255, px.data[i * 4 + 1] / 255, px.data[i * 4 + 2] / 255, px.data[i * 4 + 3] / 255) * 255);
        px = { w: px.w, h: px.h, ch: 1, data: out };
      } else if (px.ch === 3) px = luma(px);
      const jpeg = filterNames(d).includes("/DCTDecode") ? await encodeJpeg({ ...px, ch: 1 }, 85).catch(() => null) : null;
      const nd = d.clone(this.ctx);
      for (const key of ["Filter", "DecodeParms", "Decode", "Length"]) nd.delete(N(key));
      nd.set(N("ColorSpace"), GRAY);
      nd.set(N("BitsPerComponent"), PDFNumber.of(8));
      nd.set(N("Width"), PDFNumber.of(px.w));
      nd.set(N("Height"), PDFNumber.of(px.h));
      if (jpeg) {
        nd.set(N("Filter"), N("DCTDecode"));
        this.ctx.assign(ref, PDFRawStream.of(nd, jpeg));
      } else {
        nd.set(N("Filter"), N("FlateDecode"));
        nd.set(N("DecodeParms"), this.ctx.obj({ Predictor: 15, Colors: 1, BitsPerComponent: 8, Columns: px.w }));
        this.ctx.assign(ref, PDFRawStream.of(nd, zlibSync(predictPng(px.data, px.w, 1, px.h), { level: 9 })));
      }
    }
  }

  // ── Content streams. Operators that set a colour are rewritten; every
  // other byte is copied as it was. Null when nothing changed.
  content(parts: Uint8Array[], res: PDFDict | undefined): Uint8Array | null {
    if (!parts.length) return null;
    const total = parts.reduce((n, p) => n + p.length + 1, 0);
    const b = new Uint8Array(total);
    let o = 0;
    for (const p of parts) { b.set(p, o); o += p.length; b[o++] = 10; }

    const named = (name: string): Space | null => {
      if (DEVICE[name]) return DEVICE[name];
      if (name === "Pattern") return { n: 0, toGray: null, pattern: null };
      const map = res ? this.look(res.get(N("ColorSpace"))) : undefined;
      return map instanceof PDFDict ? this.space(map.get(N(name))) : null;
    };
    const enc = new TextEncoder();
    const edits: [number, number, string][] = [];
    const at = { start: 0, end: 0 };
    let operands: { t: Token; start: number }[] = [];
    let fill: Space | null = DEVICE.DeviceGray, stroke: Space | null = DEVICE.DeviceGray;
    const stack: [Space | null, Space | null][] = [];
    const nums = () => operands.flatMap((x) => ("num" in x.t ? [x.t.num] : []));
    const from = () => operands[0]?.start ?? at.start;
    const setColour = (sp: Space | null, op: string) => {
      const v = nums();
      if (!sp) return;
      if (sp.pattern !== undefined) {
        // Pattern: an optional colour in the base space, then the pattern's name.
        const base = sp.pattern;
        const name = operands.at(-1);
        if (base?.toGray && name && "name" in name.t && v.length === base.n)
          edits.push([from(), at.end, `${fmt(base.toGray(v))} /${name.t.name} ${op}`]);
        return;
      }
      if (sp.toGray && v.length === sp.n) edits.push([from(), at.end, `${fmt(sp.toGray(v))} ${op === "sc" || op === "scn" ? "g" : "G"}`]);
    };
    for (const t of tokens(b, at)) {
      if (!("op" in t) && !("inline" in t)) { operands.push({ t, start: at.start }); continue; }
      if ("inline" in t) { this.inline(b, at.start, at.end, t.inline, edits, named); operands = []; continue; }
      const v = nums();
      switch (t.op) {
        case "q": stack.push([fill, stroke]); break;
        case "Q": [fill, stroke] = stack.pop() ?? [fill, stroke]; break;
        case "g": fill = DEVICE.DeviceGray; break;
        case "G": stroke = DEVICE.DeviceGray; break;
        case "rg": case "RG":
          if (v.length === 3) edits.push([from(), at.end, `${fmt(rgbToGray(v[0], v[1], v[2]))} ${t.op === "rg" ? "g" : "G"}`]);
          if (t.op === "rg") fill = DEVICE.DeviceGray; else stroke = DEVICE.DeviceGray;
          break;
        case "k": case "K":
          if (v.length === 4) edits.push([from(), at.end, `${fmt(cmykToGray(v[0], v[1], v[2], v[3]))} ${t.op === "k" ? "g" : "G"}`]);
          if (t.op === "k") fill = DEVICE.DeviceGray; else stroke = DEVICE.DeviceGray;
          break;
        case "cs": case "CS": {
          const last = operands.at(-1);
          const sp = last && "name" in last.t ? named(last.t.name) : null;
          // A space whose colours turn grey is replaced; sc then writes g.
          if (sp?.toGray) edits.push([from(), at.end, `/DeviceGray ${t.op}`]);
          if (sp && !sp.toGray && sp.pattern === undefined && sp.n !== 1) this.left++;
          // sc and SC that follow still give colours in the old space.
          if (t.op === "cs") fill = sp; else stroke = sp;
          break;
        }
        case "sc": case "scn": setColour(fill, t.op); break;
        case "SC": case "SCN": setColour(stroke, t.op); break;
      }
      operands = [];
    }
    if (!edits.length) return null;
    edits.sort((x, y) => x[0] - y[0]);
    const out: Uint8Array[] = [];
    let pos = 0;
    for (const [s, e, text] of edits) {
      if (s < pos) continue;
      out.push(b.subarray(pos, s), enc.encode(text));
      pos = e;
    }
    out.push(b.subarray(pos));
    const len = out.reduce((n, p) => n + p.length, 0);
    const res2 = new Uint8Array(len);
    let w = 0;
    for (const p of out) { res2.set(p, w); w += p.length; }
    return res2;
  }

  // An inline image (BI … ID data EI) in RGB or CMYK, 8 bits, unfiltered or
  // Flate without a predictor, is written again in grey.
  inline(b: Uint8Array, start: number, end: number, dict: Record<string, string | number>, edits: [number, number, string][], named: (n: string) => Space | null) {
    const cs = dict.CS ?? dict.ColorSpace;
    const sp = typeof cs === "string" ? named(cs.replace(/^\//, "")) : null;
    if (!sp?.toGray || sp.n === 1) return;
    const w = Number(dict.W ?? dict.Width), h = Number(dict.H ?? dict.Height), bpc = Number(dict.BPC ?? dict.BitsPerComponent);
    const filter = String(dict.F ?? dict.Filter ?? "");
    const src = b.subarray(start, end);
    const text = new TextDecoder("latin1").decode(src);
    const id = text.search(/\sID[\s]/);
    const ei = text.lastIndexOf("EI");
    if (id < 0 || ei < id || bpc !== 8 || !(w > 0 && h > 0) || dict.DP || dict.DecodeParms || dict.D || dict.Decode || !["", "/Fl", "/FlateDecode"].includes(filter)) return void this.left++;
    let data = src.subarray(id + 4, ei);
    const need = w * h * sp.n;
    if (filter) {
      try {
        data = unzlibSync(data);
      } catch {
        return void this.left++;
      }
    }
    if (data.length < need) return void this.left++;
    const gray = new Uint8Array(w * h);
    for (let i = 0; i < gray.length; i++) gray[i] = Math.round(sp.toGray(Array.from({ length: sp.n }, (_, k) => data[i * sp.n + k] / 255)) * 255);
    // Hex-encoded (ASCIIHexDecode), so the data can't contain a stray "EI".
    const hex = [...gray].map((x) => x.toString(16).padStart(2, "0")).join("") + ">";
    edits.push([start, end, `BI /W ${w} /H ${h} /BPC 8 /CS /G /F /AHx ID ${hex} EI`]);
  }

  replace(ref: PDFObject | undefined, s: PDFRawStream, bytes: Uint8Array) {
    const nd = s.dict.clone(this.ctx);
    for (const k of ["Filter", "DecodeParms", "Length"]) nd.delete(N(k));
    nd.set(N("Filter"), N("FlateDecode"));
    const ns = PDFRawStream.of(nd, zlibSync(bytes));
    if (ref instanceof PDFRef) this.ctx.assign(ref, ns);
    return ns;
  }

  // Colour arrays on annotations and fields (/C, /IC, /MK /BC and /BG) and
  // default appearances ("0 0 1 rg" in /DA).
  annotation(a: PDFDict, pageRes: PDFDict | undefined) {
    for (const k of ["C", "IC"]) this.colourArray(a, k);
    const mk = this.look(a.get(N("MK")));
    if (mk instanceof PDFDict) for (const k of ["BC", "BG"]) this.colourArray(mk, k);
    this.da(a);
    const ap = this.look(a.get(N("AP")));
    if (!(ap instanceof PDFDict)) return;
    for (const [, v] of ap.entries()) {
      const s = this.look(v);
      if (s instanceof PDFDict) for (const [, x] of s.entries()) this.xobject(x, pageRes);
      else this.xobject(v, pageRes);
    }
  }
  colourArray(d: PDFDict, k: string) {
    const a = this.look(d.get(N(k)));
    if (!(a instanceof PDFArray) || a.size() < 3) return;
    const v = a.asArray().map((x) => (this.look(x) as PDFNumber)?.asNumber?.() ?? 0);
    d.set(N(k), this.ctx.obj([a.size() === 3 ? rgbToGray(v[0], v[1], v[2]) : cmykToGray(v[0], v[1], v[2], v[3])]));
  }
  da(d: PDFDict) {
    const da = d.get(N("DA"));
    if (!(da instanceof PDFString || da instanceof PDFHexString)) return;
    const s = da.decodeText();
    const t = s
      .replace(/(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+rg\b/g, (_, r, g, b) => `${fmt(rgbToGray(+r, +g, +b))} g`)
      .replace(/(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+k\b/g, (_, c, m, y, k) => `${fmt(cmykToGray(+c, +m, +y, +k))} g`);
    if (t !== s) d.set(N("DA"), PDFString.of(t));
  }
}

export async function grayscale(file: File, progress?: Progress): Promise<Output[]> {
  const { doc } = await openForEdit(await bytesOf(file), file.name);
  const g = new Greyer(doc);
  const ctx = doc.context;
  const pages = doc.getPages();
  for (const page of pages) {
    const res = page.node.Resources();
    g.resources(res);
    g.group(page.node);
    const out = g.content(contentBytes(page.node.get(N("Contents")), doc), res);
    if (out) page.node.set(N("Contents"), ctx.register(PDFRawStream.of(ctx.obj({ Filter: "FlateDecode" }), zlibSync(out))));
    const annots = page.node.Annots();
    for (const a of annots?.asArray() ?? []) {
      const d = ctx.lookup(a);
      if (d instanceof PDFDict) g.annotation(d, res);
    }
  }
  const acro = ctx.lookup(doc.catalog.get(N("AcroForm")));
  if (acro instanceof PDFDict) {
    g.da(acro);
    g.resources(acro.get(N("DR")));
    const fields = ctx.lookup(acro.get(N("Fields")));
    const walk = (f: PDFObject | undefined, depth = 0) => {
      const d = ctx.lookup(f as PDFRef);
      if (!(d instanceof PDFDict) || depth > 32) return;
      g.da(d);
      const kids = ctx.lookup(d.get(N("Kids")));
      if (kids instanceof PDFArray) for (const k of kids.asArray()) walk(k, depth + 1);
    };
    if (fields instanceof PDFArray) for (const f of fields.asArray()) walk(f);
  }
  // Output intents name a colour printer profile; a grey file has no use for it.
  doc.catalog.delete(N("OutputIntents"));
  await g.convertImages(progress);
  let bytes = await doc.save({ useObjectStreams: true, addDefaultPage: false, updateFieldAppearances: false });
  // pdf-lib keeps the colour streams that were replaced; qpdf writes only what is still used.
  try {
    bytes = (await runQpdf(bytes, (i, o) => ["--object-streams=generate", "--compression-level=9", i, o])).output;
  } catch {
    /* keep pdf-lib's file */
  }
  return [{ name: `${baseName(file.name)}-grayscale.pdf`, blob: pdfBlob(bytes), note: g.left ? `grayPartial:${g.left}` : undefined }];
}
