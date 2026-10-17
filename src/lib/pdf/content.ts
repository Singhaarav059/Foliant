// A content-stream tokenizer: operators, numbers, names, decoded strings,
// array brackets and inline images. Shared by Compress (placements.ts) and
// PDF/A (pdfa.ts); dictionaries in operands (BDC properties) come through as
// their tokens between "<<" and ">>" markers.

import { PDFArray, PDFRawStream, PDFRef, decodePDFRawStream, type PDFDocument, type PDFObject } from "pdf-lib";

export type Token =
  | { op: string }
  | { num: number }
  | { name: string }
  | { str: Uint8Array }
  | { mark: "[" | "]" | "<<" | ">>" }
  | { inline: Record<string, string | number> };

const WS = new Set([0, 9, 10, 12, 13, 32]);
const DELIM = new Set([40, 41, 60, 62, 91, 93, 123, 125, 47, 37]);
const ESC: Record<number, number> = { 110: 10, 114: 13, 116: 9, 98: 8, 102: 12, 40: 40, 41: 41, 92: 92 };

export function* tokens(b: Uint8Array): Generator<Token> {
  let i = 0;
  const n = b.length;
  const word = (from: number) => {
    let j = from;
    while (j < n && !WS.has(b[j]) && !DELIM.has(b[j])) j++;
    return j;
  };
  while (i < n) {
    const c = b[i];
    if (WS.has(c)) { i++; continue; }
    if (c === 37) { while (i < n && b[i] !== 10 && b[i] !== 13) i++; continue; } // % comment
    if (c === 40) { // (literal string): nesting and escapes
      const out: number[] = [];
      let depth = 1;
      i++;
      while (i < n && depth) {
        const ch = b[i];
        if (ch === 92) {
          const nx = b[i + 1];
          if (nx >= 48 && nx <= 55) { // \ddd octal
            let v = 0, k = 0;
            while (k < 3 && b[i + 1 + k] >= 48 && b[i + 1 + k] <= 55) v = v * 8 + b[i + 1 + k++] - 48;
            out.push(v & 255);
            i += 1 + k;
          } else if (nx === 13 || nx === 10) { // line continuation
            i += nx === 13 && b[i + 2] === 10 ? 3 : 2;
          } else {
            out.push(ESC[nx] ?? nx);
            i += 2;
          }
          continue;
        }
        if (ch === 40) depth++;
        else if (ch === 41 && --depth === 0) { i++; break; }
        out.push(ch);
        i++;
      }
      yield { str: Uint8Array.from(out) };
      continue;
    }
    if (c === 60 && b[i + 1] === 60) { i += 2; yield { mark: "<<" }; continue; }
    if (c === 62 && b[i + 1] === 62) { i += 2; yield { mark: ">>" }; continue; }
    if (c === 60) { // <hex string>
      let hex = "";
      for (i++; i < n && b[i] !== 62; i++) if (!WS.has(b[i])) hex += String.fromCharCode(b[i]);
      i++;
      if (hex.length % 2) hex += "0";
      yield { str: Uint8Array.from(hex.match(/../g) ?? [], (h) => parseInt(h, 16)) };
      continue;
    }
    if (c === 91 || c === 93) { i++; yield { mark: c === 91 ? "[" : "]" }; continue; }
    if (c === 123 || c === 125 || c === 41 || c === 62) { i++; continue; }
    if (c === 47) { // /Name, with #xx escapes
      const j = word(i + 1);
      yield { name: String.fromCharCode(...b.subarray(i + 1, j)).replace(/#([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16))) };
      i = j;
      continue;
    }
    const j = word(i);
    if (j === i) { i++; continue; }
    const w = String.fromCharCode(...b.subarray(i, j));
    i = j;
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(w)) { yield { num: Number(w) }; continue; }
    if (w === "BI") {
      // Inline image: its dictionary up to ID, then binary data up to EI between whitespace.
      const dict: Record<string, string | number> = {};
      let key: string | null = null;
      while (i < n) {
        while (i < n && WS.has(b[i])) i++;
        if (b[i] === 73 && b[i + 1] === 68 && (WS.has(b[i + 2]) || i + 2 >= n)) { i += 3; break; } // ID
        if (b[i] === 47) {
          const k = word(i + 1);
          const nm = String.fromCharCode(...b.subarray(i + 1, k));
          if (key === null) key = nm;
          else { dict[key] = nm; key = null; }
          i = k;
        } else {
          const k = Math.max(word(i), i + 1);
          const v = String.fromCharCode(...b.subarray(i, k));
          if (key !== null) { dict[key] = /^[+-]?[\d.]+$/.test(v) ? Number(v) : v; key = null; }
          i = k;
        }
      }
      while (i < n && !(WS.has(b[i - 1]) && b[i] === 69 && b[i + 1] === 73 && (i + 2 >= n || WS.has(b[i + 2])))) i++;
      i += 2;
      yield { inline: dict };
      continue;
    }
    yield { op: w };
  }
}

// The decoded bytes of a page's /Contents (a stream or an array of them) or a form XObject.
export function contentBytes(obj: PDFObject | undefined, doc: PDFDocument): Uint8Array[] {
  const o = obj instanceof PDFRef ? doc.context.lookup(obj) : obj;
  if (o instanceof PDFRawStream) {
    try {
      return [decodePDFRawStream(o).decode()];
    } catch {
      return [];
    }
  }
  if (o instanceof PDFArray) return o.asArray().flatMap((x) => contentBytes(x, doc));
  return [];
}
