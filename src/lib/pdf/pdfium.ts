// PDFium compiled to WebAssembly (EmbedPDF's build, MIT; PDFium itself is
// BSD/Apache). Used for true redaction: EPDFText_RedactInQuads removes the
// text, image pixels and vector shapes under each box from the page content,
// then FPDFPage_GenerateContent writes the page back out.

import { VENDOR } from "../vendor";

type Pdfium = Awaited<ReturnType<typeof import("@embedpdf/pdfium").init>>;

// Tests read the file from disk instead.
export const pdfiumWasm = {
  load: async (): Promise<ArrayBuffer> => (await fetch(`${VENDOR}pdfium.wasm`)).arrayBuffer(),
};

let loading: Promise<Pdfium> | null = null;

// The glue code; also loaded ahead of use by src/lib/offline.ts.
export const preparePdfium = () => import("@embedpdf/pdfium");

export function pdfium() {
  loading ??= (async () => {
    const { init } = await preparePdfium();
    const m = await init({ wasmBinary: await pdfiumWasm.load() });
    m.PDFiumExt_Init();
    return m;
  })();
  // A failed load shouldn't stick: the next call tries again.
  loading.catch(() => (loading = null));
  return loading;
}

// Boxes in PDF user space (points, bottom-left origin).
export type Box = { x0: number; y0: number; x1: number; y1: number };

// Redacts each page's boxes in place and draws black boxes over them.
// Returns the new file and the pages PDFium couldn't redact.
export async function redactInPlace(bytes: Uint8Array, boxes: Map<number, Box[]>): Promise<{ bytes: Uint8Array; failed: number[] }> {
  const m = await pdfium();
  const { malloc, free } = m.pdfium.wasmExports as unknown as { malloc: (n: number) => number; free: (p: number) => void };
  // Read the heap each time: it's replaced when WASM memory grows.
  const heap = () => (m.pdfium as unknown as { HEAPU8: Uint8Array }).HEAPU8;
  const file = malloc(bytes.length);
  heap().set(bytes, file);
  const doc = m.FPDF_LoadMemDocument(file, bytes.length, "");
  if (!doc) {
    free(file);
    throw new Error(`PDFium could not open the file (error ${m.FPDF_GetLastError()})`);
  }
  const failed: number[] = [];
  try {
    for (const [index, list] of boxes) {
      const page = m.FPDF_LoadPage(doc, index);
      if (!page) {
        failed.push(index);
        continue;
      }
      // FS_QUADPOINTSF: top-left, top-right, bottom-left, bottom-right as float pairs.
      const quads = malloc(32 * list.length);
      list.forEach((b, i) => {
        [b.x0, b.y1, b.x1, b.y1, b.x0, b.y0, b.x1, b.y0].forEach((v, k) => m.pdfium.setValue(quads + i * 32 + k * 4, v, "float"));
      });
      try {
        // Arguments: page, quads, count, also inside form XObjects, draw black boxes.
        const ok = m.EPDFText_RedactInQuads(page, quads, list.length, true, true) && m.FPDFPage_GenerateContent(page);
        if (!ok) failed.push(index);
      } finally {
        free(quads);
        m.FPDF_ClosePage(page);
      }
    }
    return { bytes: saveCopy(m, doc), failed };
  } finally {
    m.FPDF_CloseDocument(doc);
    free(file);
  }
}

// A whole new file of the document. `removeSecurity` writes it unencrypted.
function saveCopy(m: Pdfium, doc: number, removeSecurity = false) {
  const { malloc, free } = m.pdfium.wasmExports as unknown as { malloc: (n: number) => number; free: (p: number) => void };
  const writer = m.PDFiumExt_OpenFileWriter();
  try {
    // FPDF_REMOVE_SECURITY is 3.
    const ok = removeSecurity ? m.FPDF_SaveAsCopy(doc, writer, 3) : m.PDFiumExt_SaveAsCopy(doc, writer);
    if (!ok) throw new Error("PDFium could not save the file");
    const size = m.PDFiumExt_GetFileWriterSize(writer);
    const data = malloc(size);
    m.PDFiumExt_GetFileWriterData(writer, data, size);
    const out = (m.pdfium as unknown as { HEAPU8: Uint8Array }).HEAPU8.slice(data, data + size);
    free(data);
    return out;
  } finally {
    m.PDFiumExt_CloseFileWriter(writer);
  }
}

// The file opened with its password and written out unencrypted. PDFium
// reads damaged files qpdf gives up on, encrypted object streams included.
export async function decryptedCopy(bytes: Uint8Array, password: string): Promise<Uint8Array> {
  const m = await pdfium();
  const { malloc, free } = m.pdfium.wasmExports as unknown as { malloc: (n: number) => number; free: (p: number) => void };
  const file = malloc(bytes.length);
  (m.pdfium as unknown as { HEAPU8: Uint8Array }).HEAPU8.set(bytes, file);
  const doc = m.FPDF_LoadMemDocument(file, bytes.length, password);
  if (!doc) {
    free(file);
    throw new Error(`PDFium could not open the file (error ${m.FPDF_GetLastError()})`);
  }
  try {
    return saveCopy(m, doc, true);
  } finally {
    m.FPDF_CloseDocument(doc);
    free(file);
  }
}

// ── Editing the page's own text
// A text object is one run of text shown with one font: usually a line, or a
// piece of one. Each is changed in place with FPDFText_SetText when its font
// has every glyph the new text needs; otherwise it is replaced by new objects
// in bundled fonts. FPDFPage_GenerateContent then writes the page's content
// again, so the old text is not left in it. Text inside form XObjects is not
// listed and can't be changed.

type Mem = { m: Pdfium; malloc: (n: number) => number; free: (p: number) => void; heap: () => Uint8Array };

function memOf(m: Pdfium): Mem {
  const { malloc, free } = m.pdfium.wasmExports as unknown as { malloc: (n: number) => number; free: (p: number) => void };
  return { m, malloc, free, heap: () => (m.pdfium as unknown as { HEAPU8: Uint8Array }).HEAPU8 };
}

// Calls `fn` with room for `n` values, and reads them back as `type`.
function values(x: Mem, n: number, type: "float" | "i32", fn: (p: number) => unknown): number[] | null {
  const p = x.malloc(4 * n);
  try {
    if (fn(p) === false) return null;
    return Array.from({ length: n }, (_, i) => x.m.pdfium.getValue(p + 4 * i, type) as number);
  } finally {
    x.free(p);
  }
}

// A string PDFium writes into a buffer it was asked the size of first.
function readString(x: Mem, utf16: boolean, fn: (buf: number, len: number) => number): string {
  const len = fn(0, 0);
  if (len <= (utf16 ? 2 : 1)) return "";
  const p = x.malloc(len);
  try {
    fn(p, len);
    const bytes = x.heap().slice(p, p + len - (utf16 ? 2 : 1));
    return new TextDecoder(utf16 ? "utf-16le" : "utf-8").decode(bytes);
  } finally {
    x.free(p);
  }
}

function withWide<T>(x: Mem, s: string, fn: (p: number) => T): T {
  const p = x.malloc((s.length + 1) * 2);
  try {
    for (let i = 0; i < s.length; i++) x.m.pdfium.setValue(p + i * 2, s.charCodeAt(i), "i16");
    x.m.pdfium.setValue(p + s.length * 2, 0, "i16");
    return fn(p);
  } finally {
    x.free(p);
  }
}

async function openDoc(bytes: Uint8Array) {
  const m = await pdfium();
  const x = memOf(m);
  const file = x.malloc(bytes.length);
  x.heap().set(bytes, file);
  const doc = m.FPDF_LoadMemDocument(file, bytes.length, "");
  if (!doc) {
    x.free(file);
    throw new Error(`PDFium could not open the file (error ${m.FPDF_GetLastError()})`);
  }
  return { x, doc, close: () => (m.FPDF_CloseDocument(doc), x.free(file)) };
}

function saveDoc(x: Mem, doc: number): Uint8Array {
  const { m } = x;
  const writer = m.PDFiumExt_OpenFileWriter();
  try {
    if (!m.PDFiumExt_SaveAsCopy(doc, writer)) throw new Error("PDFium could not save the file");
    const size = m.PDFiumExt_GetFileWriterSize(writer);
    const data = x.malloc(size);
    m.PDFiumExt_GetFileWriterData(writer, data, size);
    const out = x.heap().slice(data, data + size);
    x.free(data);
    return out;
  } finally {
    m.PDFiumExt_CloseFileWriter(writer);
  }
}

// The page's boxes (as stored, left/bottom/right/top) and /Rotate in degrees.
export type PageGeom = { media: Box; crop: Box | null; rotate: number };

function geomOf(x: Mem, page: number): PageGeom {
  const { m } = x;
  const box = (fn: (l: number, b: number, r: number, t: number) => unknown) => {
    const v = values(x, 4, "float", (p) => fn(p, p + 4, p + 8, p + 12));
    return v ? { x0: v[0], y0: v[1], x1: v[2], y1: v[3] } : null;
  };
  return {
    media: box((l, b, r, t) => m.FPDFPage_GetMediaBox(page, l, b, r, t)) ?? { x0: 0, y0: 0, x1: 612, y1: 792 },
    crop: box((l, b, r, t) => m.FPDFPage_GetCropBox(page, l, b, r, t)),
    rotate: (((m.FPDFPage_GetRotation(page) as number) % 4) + 4) % 4 * 90,
  };
}

export type TextObject = {
  index: number; // among the page's top-level objects
  text: string;
  font: string;
  size: number; // Tf size; the matrix may scale it
  matrix: number[]; // a b c d e f, text space → user space
  bounds: Box;
  fill: [number, number, number, number]; // RGBA, 0–255
  bold: boolean;
  italic: boolean;
};

const TEXT = 1;

function fontInfo(x: Mem, font: number) {
  const name = readString(x, false, (b, l) => x.m.FPDFFont_GetBaseFontName(font, b, l));
  const weight = x.m.FPDFFont_GetWeight(font) as number;
  const angle = values(x, 1, "i32", (p) => x.m.FPDFFont_GetItalicAngle(font, p))?.[0] ?? 0;
  const plain = name.replace(/^[A-Z]{6}\+/, "");
  return {
    name: plain,
    flags: x.m.FPDFFont_GetFlags(font) as number,
    bold: weight >= 600 || /bold|black|heavy|semibold|demi/i.test(plain),
    italic: angle !== 0 || /italic|oblique/i.test(plain),
  };
}

function textObjectAt(x: Mem, page: number, textPage: number, index: number): (TextObject & { handle: number; fontHandle: number }) | null {
  const { m } = x;
  const o = m.FPDFPage_GetObject(page, index);
  if (!o || m.FPDFPageObj_GetType(o) !== TEXT) return null;
  const fontHandle = m.FPDFTextObj_GetFont(o);
  const info = fontInfo(x, fontHandle);
  const b = values(x, 4, "float", (p) => m.FPDFPageObj_GetBounds(o, p, p + 4, p + 8, p + 12)) ?? [0, 0, 0, 0];
  return {
    handle: o,
    fontHandle,
    index,
    text: readString(x, true, (buf, len) => m.FPDFTextObj_GetText(o, textPage, buf, len)),
    font: info.name,
    size: values(x, 1, "float", (p) => m.FPDFTextObj_GetFontSize(o, p))?.[0] ?? 12,
    matrix: values(x, 6, "float", (p) => m.FPDFPageObj_GetMatrix(o, p)) ?? [1, 0, 0, 1, 0, 0],
    bounds: { x0: b[0], y0: b[1], x1: b[2], y1: b[3] },
    fill: (values(x, 4, "i32", (p) => m.FPDFPageObj_GetFillColor(o, p, p + 4, p + 8, p + 12)) ?? [0, 0, 0, 255]) as TextObject["fill"],
    bold: info.bold,
    italic: info.italic,
  };
}

// The text objects of one page, with the page's geometry.
export async function textObjects(bytes: Uint8Array, pageIndex: number): Promise<{ geom: PageGeom; objects: TextObject[] }> {
  const { x, doc, close } = await openDoc(bytes);
  const { m } = x;
  try {
    const page = m.FPDF_LoadPage(doc, pageIndex);
    if (!page) throw new Error(`PDFium could not load page ${pageIndex + 1}`);
    const textPage = m.FPDFText_LoadPage(page);
    try {
      const objects: TextObject[] = [];
      const n = m.FPDFPage_CountObjects(page) as number;
      for (let i = 0; i < n; i++) {
        const o = textObjectAt(x, page, textPage, i);
        if (o && o.text.trim()) {
          const { handle: _h, fontHandle: _f, ...rest } = o; // eslint-disable-line @typescript-eslint/no-unused-vars
          objects.push(rest);
        }
      }
      return { geom: geomOf(x, page), objects };
    } finally {
      m.FPDFText_ClosePage(textPage);
      m.FPDF_ClosePage(page);
    }
  } finally {
    close();
  }
}

// Scripts PDFium can set without shaping or reordering. Arabic, Hebrew and
// the Indic and South-East Asian scripts need both, which FPDFText_SetText
// doesn't do, so text in them is refused rather than drawn wrong.
const UNSHAPED = /^[\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Bopomofo}\p{Script=Common}\p{Script=Inherited}]*$/u;
export const canSetText = (text: string) => UNSHAPED.test(text) && !/[‌‍‪-‮⁦-⁩]/.test(text);

// Whether `font` can show `text`: every character has a code in the font's
// encoding (set on a scratch object and read back the same) and every
// visible character a real glyph, not the one shown for a missing glyph.
function fontCovers(x: Mem, doc: number, page: number, font: number, text: string): boolean {
  const { m } = x;
  if (!text) return true;
  const scratch = m.FPDFPageObj_CreateTextObj(doc, font, 12);
  if (!scratch) return false;
  m.FPDFPage_InsertObject(page, scratch);
  try {
    if (!withWide(x, text, (p) => m.FPDFText_SetText(scratch, p))) return false;
    const tp = m.FPDFText_LoadPage(page);
    const back = readString(x, true, (buf, len) => m.FPDFTextObj_GetText(scratch, tp, buf, len));
    m.FPDFText_ClosePage(tp);
    if (back.replace(/\s+/g, "") !== text.replace(/\s+/g, "")) return false;
  } finally {
    m.FPDFPage_RemoveObject(page, scratch);
    m.FPDFPageObj_Destroy(scratch);
  }
  // U+FFFE is never a character, so whatever it draws is the missing glyph.
  const glyph = (cp: number) => {
    const path = m.FPDFFont_GetGlyphPath(font, cp, 12);
    const width = values(x, 1, "float", (p) => m.FPDFFont_GetGlyphWidth(font, cp, 12, p))?.[0] ?? -1;
    return { segments: path ? (m.FPDFGlyphPath_CountGlyphSegments(path) as number) : -1, width };
  };
  const missing = glyph(0xfffe);
  for (const ch of new Set(Array.from(text))) {
    if (/\s/.test(ch)) continue;
    const g = glyph(ch.codePointAt(0)!);
    if (g.segments <= 0) return false;
    if (g.segments === missing.segments && Math.abs(g.width - missing.width) < 1e-3) return false;
  }
  return true;
}

// Text in bundled fonts, for when the object's own font lacks glyphs: runs in
// order, each with an OpenType/TrueType font program. Null when no bundled
// font has some character.
export type FallbackRun = { text: string; key: string; name: string; font: () => Promise<Uint8Array> };
export type Fallback = (text: string, like: { name: string; flags: number; bold: boolean; italic: boolean }) => Promise<FallbackRun[] | null>;

export type TextChange = {
  page: number;
  index: number;
  was: string; // the object's text when it was listed; a mismatch refuses the change
  text: string; // "" deletes it
  move?: [number, number]; // in visual fractions of the page
};
export type TextResult = {
  page: number;
  index: number;
  font: string;
  fallback?: string[]; // bundled fonts used instead of `font`
  error?: "changed" | "script" | "glyphs" | "page";
};

// Whether new text for one object would keep its font, before saving.
export async function textFontCheck(bytes: Uint8Array, pageIndex: number, index: number, text: string, fallback: Fallback):
  Promise<{ kept: true; font: string } | { kept: false; font: string; fallback: string[] | null } | { unsupported: true }> {
  if (!canSetText(text)) return { unsupported: true };
  const { x, doc, close } = await openDoc(bytes);
  const { m } = x;
  try {
    const page = m.FPDF_LoadPage(doc, pageIndex);
    if (!page) return { unsupported: true };
    const tp = m.FPDFText_LoadPage(page);
    try {
      const o = textObjectAt(x, page, tp, index);
      if (!o) return { unsupported: true };
      if (fontCovers(x, doc, page, o.fontHandle, text)) return { kept: true, font: o.font };
      const runs = await fallback(text, fontInfo(x, o.fontHandle));
      return { kept: false, font: o.font, fallback: runs ? [...new Set(runs.map((r) => r.name))] : null };
    } finally {
      m.FPDFText_ClosePage(tp);
      m.FPDF_ClosePage(page);
    }
  } finally {
    close();
  }
}

// Applies the changes. `delta` turns a move in visual fractions into user
// space for the page's geometry. Every change is applied or the whole call
// fails: results say which font each change used, and why one failed.
export async function editTextObjects(
  bytes: Uint8Array, changes: TextChange[], fallback: Fallback, delta: (geom: PageGeom, move: [number, number]) => [number, number],
): Promise<{ bytes: Uint8Array; results: TextResult[] }> {
  const { x, doc, close } = await openDoc(bytes);
  const { m } = x;
  const results: TextResult[] = [];
  // Font programs stay in WASM memory until the document is closed.
  const buffers: number[] = [];
  const loaded = new Map<string, number>();
  const loadFont = async (run: FallbackRun) => {
    let f = loaded.get(run.key);
    if (f === undefined) {
      const data = await run.font();
      const p = x.malloc(data.length);
      x.heap().set(data, p);
      buffers.push(p);
      // FPDF_FONT_TRUETYPE, as a CID font so any character can be encoded.
      f = m.FPDFText_LoadFont(doc, p, data.length, 2, true) as number;
      loaded.set(run.key, f);
    }
    return f;
  };
  try {
    const pages = [...new Set(changes.map((c) => c.page))];
    for (const pageIndex of pages) {
      const page = m.FPDF_LoadPage(doc, pageIndex);
      if (!page) {
        for (const c of changes.filter((c) => c.page === pageIndex)) results.push({ page: c.page, index: c.index, font: "", error: "page" });
        continue;
      }
      const tp = m.FPDFText_LoadPage(page);
      try {
        const geom = geomOf(x, page);
        // Highest index first, so replacing one object doesn't move the others.
        const list = changes.filter((c) => c.page === pageIndex).sort((a, b) => b.index - a.index);
        const targets = list.map((c) => ({ c, o: textObjectAt(x, page, tp, c.index) }));
        for (const { c, o } of targets) {
          if (!o || o.text !== c.was) {
            results.push({ page: c.page, index: c.index, font: o?.font ?? "", error: "changed" });
            continue;
          }
          if (!canSetText(c.text)) {
            results.push({ page: c.page, index: c.index, font: o.font, error: "script" });
            continue;
          }
          const [dx, dy] = c.move && (c.move[0] || c.move[1]) ? delta(geom, c.move) : [0, 0];
          if (!c.text) {
            m.FPDFPage_RemoveObject(page, o.handle);
            m.FPDFPageObj_Destroy(o.handle);
            results.push({ page: c.page, index: c.index, font: o.font });
            continue;
          }
          if (c.text === o.text || fontCovers(x, doc, page, o.fontHandle, c.text)) {
            if (c.text !== o.text && !withWide(x, c.text, (p) => m.FPDFText_SetText(o.handle, p))) {
              results.push({ page: c.page, index: c.index, font: o.font, error: "glyphs" });
              continue;
            }
            if (dx || dy) m.FPDFPageObj_Transform(o.handle, 1, 0, 0, 1, dx, dy);
            results.push({ page: c.page, index: c.index, font: o.font });
            continue;
          }
          const runs = await fallback(c.text, fontInfo(x, o.fontHandle));
          if (!runs) {
            results.push({ page: c.page, index: c.index, font: o.font, error: "glyphs" });
            continue;
          }
          // New objects where the old one was, each run starting where the
          // last one's advance ends, with its colour and render mode.
          const [a, b, cc, d, e, f] = o.matrix;
          const stroke = values(x, 4, "i32", (p) => m.FPDFPageObj_GetStrokeColor(o.handle, p, p + 4, p + 8, p + 12));
          const mode = m.FPDFTextObj_GetTextRenderMode(o.handle) as number;
          const made: number[] = [];
          let advance = 0;
          for (const run of runs) {
            const font = await loadFont(run);
            const obj = font ? m.FPDFPageObj_CreateTextObj(doc, font, o.size) : 0;
            if (!obj || !withWide(x, run.text, (p) => m.FPDFText_SetText(obj, p))) {
              if (obj) m.FPDFPageObj_Destroy(obj);
              made.splice(0).forEach((h) => m.FPDFPageObj_Destroy(h));
              break;
            }
            const matrix = [a, b, cc, d, e + a * advance + dx, f + b * advance + dy];
            const mp = x.malloc(24);
            matrix.forEach((v, i) => m.pdfium.setValue(mp + 4 * i, v, "float"));
            m.FPDFPageObj_SetMatrix(obj, mp);
            x.free(mp);
            m.FPDFPageObj_SetFillColor(obj, ...o.fill);
            if (stroke) m.FPDFPageObj_SetStrokeColor(obj, stroke[0], stroke[1], stroke[2], stroke[3]);
            if (mode >= 0) m.FPDFTextObj_SetTextRenderMode(obj, mode);
            for (const ch of run.text) {
              advance += values(x, 1, "float", (p) => m.FPDFFont_GetGlyphWidth(font, ch.codePointAt(0)!, o.size, p))?.[0] ?? 0;
            }
            made.push(obj);
          }
          if (made.length !== runs.length) {
            results.push({ page: c.page, index: c.index, font: o.font, error: "glyphs" });
            continue;
          }
          m.FPDFPage_RemoveObject(page, o.handle);
          m.FPDFPageObj_Destroy(o.handle);
          made.forEach((obj, k) => m.FPDFPage_InsertObjectAtIndex(page, obj, c.index + k));
          results.push({ page: c.page, index: c.index, font: o.font, fallback: [...new Set(runs.map((r) => r.name))] });
        }
        if (!m.FPDFPage_GenerateContent(page)) {
          for (const r of results) if (r.page === pageIndex && !r.error) r.error = "page";
        }
      } finally {
        m.FPDFText_ClosePage(tp);
        m.FPDF_ClosePage(page);
      }
    }
    return { bytes: saveDoc(x, doc), results };
  } finally {
    close();
    buffers.forEach((p) => x.free(p));
  }
}
