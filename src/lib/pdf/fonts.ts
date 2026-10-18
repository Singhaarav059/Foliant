"use client";

// Real, selectable text for scripts Helvetica can't encode (Arabic, Hindi,
// Thai, CJK, Cyrillic, Greek, Vietnamese…), using the Noto slices that
// scripts/vendor.mjs copies to /vendor/<hash>/fonts. A line is split into runs by
// font slice and bidi level, reordered for display, and each run is drawn
// with its own subset-embedded font. fontkit does the shaping (Arabic
// joining, Indic reordering) and reverses right-to-left runs itself.

// fontkit's Indic and Universal shapers are compiled generators that expect a
// global regeneratorRuntime; this sets it.
import "regenerator-runtime/runtime";
import fontkit from "@pdf-lib/fontkit";
import type { PDFDocument, PDFFont } from "pdf-lib";
import { VENDOR } from "../vendor";

type Face = { file: string; weight: number; ranges: number[] };
type Group = "base" | "arabic" | "thai" | "sc" | "tc" | "jp" | "kr";
type Manifest = Record<Group, Face[]>;
type Kit = ReturnType<typeof fontkit.create>;

export type TextRun = { font: PDFFont; text: string; x: number };
export type LaidOut = { width: number; runs: TextRun[] };

// Latin families a user can pick for added text (page numbers, watermarks),
// all OFL: Arimo (Arial/Helvetica metrics), Tinos (Times) and Cousine
// (Courier). scripts/vendor.mjs copies their Latin WOFFs to pdfa-fonts/.
// Characters they lack still come from Noto.
export type Family = "arimo" | "tinos" | "cousine";
export const FAMILIES: readonly Family[] = ["arimo", "tinos", "cousine"];
const familyFace = (family: Family, weight: number): Face => ({
  file: `${VENDOR}pdfa-fonts/${family}-latin-${weight}-normal.woff`, weight, ranges: [0, 0x10ffff],
});

const BASE = `${VENDOR}fonts/`;
let manifest: Promise<Manifest> | null = null;
const bytes = new Map<string, Promise<Uint8Array>>();
const kits = new Map<string, Promise<Kit>>();
const embedded = new WeakMap<PDFDocument, Map<string, Promise<PDFFont>>>();

function loadManifest() {
  manifest ??= fetch(`${BASE}fonts.json`).then((r) => {
    if (!r.ok) throw new Error("Font list unavailable");
    return r.json() as Promise<Manifest>;
  });
  manifest.catch(() => (manifest = null)); // retry next time, e.g. back online
  return manifest;
}

function fontBytes(file: string) {
  let p = bytes.get(file);
  if (!p) {
    p = fetch(file.startsWith("/") ? file : BASE + file).then(async (r) => {
      if (!r.ok) throw new Error(`Font ${file} unavailable`);
      return new Uint8Array(await r.arrayBuffer());
    });
    p.catch(() => bytes.delete(file));
    bytes.set(file, p);
  }
  return p;
}

function kit(face: Face) {
  let p = kits.get(face.file);
  if (!p) {
    p = fontBytes(face.file).then((b) => fontkit.create(b) as Kit);
    p.catch(() => kits.delete(face.file));
    kits.set(face.file, p);
  }
  return p;
}

function embed(doc: PDFDocument, face: Face) {
  let perDoc = embedded.get(doc);
  if (!perDoc) embedded.set(doc, (perDoc = new Map()));
  let p = perDoc.get(face.file);
  if (!p) {
    doc.registerFontkit(fontkit);
    // Slices are WOFF, which only the subsetting embedder re-encodes as TrueType.
    p = fontBytes(face.file).then((b) => doc.embedFont(b, { subset: true }));
    perDoc.set(face.file, p);
  }
  return p;
}

const inRanges = (r: number[], cp: number) => {
  for (let i = 0; i < r.length; i += 2) if (cp >= r[i] && cp <= r[i + 1]) return true;
  return false;
};

// Han characters exist in all four CJK fonts; kana or hangul in the text
// says which regional forms to prefer.
function faceOrder(m: Manifest, text: string, weight: number) {
  const cjk: Group[] = /[぀-ヿ]/.test(text) ? ["jp", "sc", "tc", "kr"]
    : /[ᄀ-ᇿ㄰-㆏가-힯]/.test(text) ? ["kr", "sc", "tc", "jp"]
    : ["sc", "tc", "jp", "kr"];
  const groups: Group[] = ["base", "arabic", "thai", ...cjk];
  return groups.flatMap((g) => m[g].filter((f) => f.weight === weight));
}

async function faceFor(faces: Face[], cp: number) {
  for (const face of faces) {
    if (inRanges(face.ranges, cp) && (await kit(face)).hasGlyphForCodePoint(cp)) return face;
  }
  return null;
}

// ── Bidi, simplified from UAX #9 for a single line without explicit
// embeddings: strong L/R, European numbers, neutrals and marks.
type Dir = "L" | "R" | "EN" | "N" | "M";
const isRtl = (cp: number) =>
  (cp >= 0x0590 && cp <= 0x08ff) || (cp >= 0xfb1d && cp <= 0xfdff) || (cp >= 0xfe70 && cp <= 0xfeff)
  || (cp >= 0x10800 && cp <= 0x10fff) || (cp >= 0x1e800 && cp <= 0x1efff);

function dirOf(ch: string, cp: number): Dir {
  if (/\p{Nd}/u.test(ch)) return "EN";
  if (/[\p{Mn}\p{Me}‌‍︀-️]/u.test(ch)) return "M";
  if (isRtl(cp)) return /[\p{L}\p{Mc}]/u.test(ch) ? "R" : "N";
  return /[\p{L}\p{Mc}]/u.test(ch) ? "L" : "N";
}

function bidiLevels(chars: string[]) {
  const dirs = chars.map((c) => dirOf(c, c.codePointAt(0)!));
  const firstStrong = dirs.find((d) => d === "L" || d === "R");
  const base = firstStrong === "R" ? 1 : 0;
  const baseDir = base ? "R" : "L";
  // W7: numbers after L (or at the start of an LTR line) are plain L.
  let last = baseDir;
  const t = dirs.map((d) => {
    if (d === "L" || d === "R") last = d;
    return d === "EN" && last === "L" ? "L" : d;
  });
  // N1/N2: neutrals between the same direction take it (numbers count as R), else the base.
  const strong = (d: Dir) => (d === "L" ? "L" : d === "R" || d === "EN" ? "R" : null);
  const resolved = t.map((d, i) => {
    if (d !== "N") return d;
    let before = baseDir as string, after = baseDir as string;
    for (let j = i - 1; j >= 0; j--) { const s = strong(t[j]); if (s) { before = s; break; } }
    for (let j = i + 1; j < t.length; j++) { const s = strong(t[j]); if (s) { after = s; break; } }
    return before === after ? before : baseDir;
  });
  // I1/I2, with marks taking the level of what they attach to.
  const levels: number[] = [];
  resolved.forEach((d, i) => {
    if (d === "M") levels.push(i ? levels[i - 1] : base);
    else if (base === 0) levels.push(d === "L" ? 0 : d === "R" ? 1 : 2);
    else levels.push(d === "R" ? 1 : 2);
  });
  return levels;
}

// L2: reverse every maximal sequence at or above each level, highest first.
function reorder<T extends { level: number }>(segs: T[]) {
  const out = [...segs];
  const max = Math.max(0, ...out.map((s) => s.level));
  const minOdd = Math.min(...out.map((s) => s.level).filter((l) => l % 2), Infinity);
  for (let lvl = max; lvl >= minOdd && lvl > 0; lvl--) {
    for (let i = 0; i < out.length; ) {
      if (out[i].level < lvl) { i++; continue; }
      let j = i;
      while (j < out.length && out[j].level >= lvl) j++;
      out.splice(i, j - i, ...out.slice(i, j).reverse());
      i = j;
    }
  }
  return out;
}

// Lays out one line, in `family` where it has the glyphs and Noto elsewhere.
// Returns null if some character has no bundled glyph, so the caller can fall
// back to an image of the text.
export async function layoutText(doc: PDFDocument, text: string, size: number, bold = false, family?: Family): Promise<LaidOut | null> {
  const chars = Array.from(text);
  if (!chars.length) return { width: 0, runs: [] };
  const weight = bold ? 700 : 400;
  const faces = [...(family ? [familyFace(family, weight)] : []), ...faceOrder(await loadManifest(), text, weight)];
  const levels = bidiLevels(chars);

  // Assign a slice to each character, keeping marks and joiners with their base.
  const assigned: Face[] = [];
  for (let i = 0; i < chars.length; i++) {
    const cp = chars[i].codePointAt(0)!;
    const prev = assigned[i - 1];
    if (prev && (dirOf(chars[i], cp) === "M" || (await kit(prev)).hasGlyphForCodePoint(cp))) {
      assigned.push(prev);
      continue;
    }
    const face = await faceFor(faces, cp);
    if (!face) return null;
    assigned.push(face);
  }

  type Seg = { face: Face; level: number; text: string };
  const segs: Seg[] = [];
  chars.forEach((ch, i) => {
    const last = segs[segs.length - 1];
    if (last && last.face === assigned[i] && last.level === levels[i]) last.text += ch;
    else segs.push({ face: assigned[i], level: levels[i], text: ch });
  });

  let x = 0;
  const runs: TextRun[] = [];
  for (const seg of reorder(segs)) {
    let t = seg.text;
    // fontkit reverses runs in a right-to-left script; a right-to-left run of
    // only spaces and punctuation it would leave as is.
    if (seg.level % 2 && !Array.from(t).some((c) => isRtl(c.codePointAt(0)!))) t = Array.from(t).reverse().join("");
    const font = await embed(doc, seg.face);
    runs.push({ font, text: t, x });
    x += font.widthOfTextAtSize(t, size);
  }
  return { width: x, runs };
}

// One embedded font that covers all of `text`, for form field appearances,
// which can only use a single font. Null if no single slice covers it.
export async function fontCovering(doc: PDFDocument, text: string): Promise<PDFFont | null> {
  const cps = Array.from(text.replace(/\s+/g, " ")).map((c) => c.codePointAt(0)!);
  const first = cps.find((cp) => cp > 0x7e);
  if (first === undefined) return null;
  for (const face of faceOrder(await loadManifest(), text, 400)) {
    if (!inRanges(face.ranges, first)) continue;
    const k = await kit(face);
    if (cps.every((cp) => k.hasGlyphForCodePoint(cp))) return embed(doc, face);
  }
  return null;
}
