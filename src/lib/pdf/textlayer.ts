// Invisible, searchable text for OCR, PDF/A and redaction.
//
// pdf-lib's standard fonts only encode WinAnsi, so instead each page gets
// small Type3 fonts with empty glyphs and a ToUnicode map. Nothing is drawn
// (render mode 3), but viewers can search, select and copy the text in any script.

import {
  PDFDocument, PDFPage, PDFName, PDFArray, PDFHexString, PDFDict,
  beginText, endText, setFontAndSize, setTextMatrix, setCharacterSqueeze,
  setTextRenderingMode, TextRenderingMode, showText, pushGraphicsState, popGraphicsState,
} from "pdf-lib";

export type Word = {
  text: string;
  x: number; // baseline start, PDF user space
  y: number;
  width: number;
  height: number;
  angle: number; // radians
};

const GLYPH_W = 500; // glyph width in 1/1000 em

function utf16Hex(ch: string) {
  let out = "";
  for (let i = 0; i < ch.length; i++) out += ch.charCodeAt(i).toString(16).padStart(4, "0");
  return out.toUpperCase();
}

function toUnicodeCMap(chars: string[]) {
  const entries = chars.map((c, i) => `<${i.toString(16).padStart(2, "0").toUpperCase()}> <${utf16Hex(c)}>`);
  const blocks: string[] = [];
  for (let i = 0; i < entries.length; i += 100) {
    const chunk = entries.slice(i, i + 100);
    blocks.push(`${chunk.length} beginbfchar\n${chunk.join("\n")}\nendbfchar`);
  }
  return [
    "/CIDInit /ProcSet findresource begin",
    "12 dict begin",
    "begincmap",
    "/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def",
    "/CMapName /Adobe-Identity-UCS def",
    "/CMapType 2 def",
    "1 begincodespacerange",
    "<00> <FF>",
    "endcodespacerange",
    ...blocks,
    "endcmap",
    "CMapName currentdict /CMap defineresource pop",
    "end",
    "end",
  ].join("\n");
}

function makeFont(doc: PDFDocument, chars: string[]) {
  const ctx = doc.context;
  const glyph = ctx.register(ctx.stream(`${GLYPH_W} 0 d0`));
  const charProcs = ctx.obj({}) as PDFDict;
  const diffs: (number | PDFName)[] = [0];
  chars.forEach((_, i) => {
    const name = PDFName.of(`g${i}`);
    charProcs.set(name, glyph);
    diffs.push(name);
  });
  const toUnicode = ctx.register(ctx.stream(toUnicodeCMap(chars)));
  const font = ctx.obj({
    Type: "Font",
    Subtype: "Type3",
    FontBBox: [0, 0, 0, 0],
    FontMatrix: [0.001, 0, 0, 0.001, 0, 0],
    CharProcs: charProcs,
    Encoding: ctx.obj({ Type: "Encoding", Differences: ctx.obj(diffs) }),
    FirstChar: 0,
    LastChar: chars.length - 1,
    Widths: ctx.obj(chars.map(() => GLYPH_W)) as PDFArray,
    ToUnicode: toUnicode,
    Resources: ctx.obj({}),
  });
  return ctx.register(font);
}

export function addInvisibleText(doc: PDFDocument, page: PDFPage, words: Word[]) {
  const clean = words
    .map((w) => ({ ...w, chars: Array.from(w.text.replace(/\s+/g, " ").trim()) }))
    .filter((w) => w.chars.length > 0 && w.width > 0 && w.height > 0);
  if (!clean.length) return;

  // Pack words into fonts of at most 256 distinct characters each.
  type Pack = { chars: string[]; index: Map<string, number>; words: typeof clean };
  const packs: Pack[] = [];
  let cur: Pack = { chars: [], index: new Map(), words: [] };
  for (const w of clean) {
    const fresh = new Set(w.chars.filter((c) => !cur.index.has(c)));
    if (cur.chars.length + fresh.size > 256) {
      packs.push(cur);
      cur = { chars: [], index: new Map(), words: [] };
    }
    for (const c of w.chars) {
      if (!cur.index.has(c) && cur.chars.length < 256) {
        cur.index.set(c, cur.chars.length);
        cur.chars.push(c);
      }
    }
    cur.words.push(w);
  }
  packs.push(cur);

  page.pushOperators(pushGraphicsState(), beginText(), setTextRenderingMode(TextRenderingMode.Invisible));
  for (const pack of packs) {
    if (!pack.chars.length) continue;
    const key = page.node.newFontDictionary("Ocr", makeFont(doc, pack.chars));
    for (const w of pack.words) {
      const codes = w.chars.map((c) => (pack.index.get(c) ?? 0).toString(16).padStart(2, "0")).join("");
      const size = Math.max(1, w.height);
      const natural = (w.chars.length * GLYPH_W * size) / 1000;
      const squeeze = Math.max(1, Math.min(1000, (w.width / natural) * 100));
      const cos = Math.cos(w.angle);
      const sin = Math.sin(w.angle);
      page.pushOperators(
        setFontAndSize(key, size),
        setCharacterSqueeze(Number(squeeze.toFixed(2))),
        setTextMatrix(cos, sin, -sin, cos, w.x, w.y),
        showText(PDFHexString.of(codes)),
      );
    }
  }
  page.pushOperators(endText(), popGraphicsState());
}

// Maps a box from rendered-viewport pixels (top-left origin) to a baseline word in PDF space.
export function viewportBoxToWord(
  text: string,
  box: { x0: number; y0: number; x1: number; y1: number },
  toPdf: (x: number, y: number) => number[],
): Word {
  const [ax, ay] = toPdf(box.x0, box.y1);
  const [bx, by] = toPdf(box.x1, box.y1);
  const [cx, cy] = toPdf(box.x0, box.y0);
  return {
    text,
    x: ax,
    y: ay,
    width: Math.hypot(bx - ax, by - ay),
    height: Math.hypot(cx - ax, cy - ay),
    angle: Math.atan2(by - ay, bx - ax),
  };
}
