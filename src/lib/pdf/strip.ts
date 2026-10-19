// Removes text objects (BT … ET) from every page and form XObject, leaving
// graphics and images. PDF → PowerPoint renders this copy as the slide
// background and lays editable text boxes on top, so text isn't doubled.

import { PDFRawStream, PDFName, PDFArray, PDFRef, PDFDict, decodePDFRawStream, PDFStream } from "pdf-lib";
import { zlibSync } from "fflate";
import { openForEdit } from "./open";

const isWs = (c: number) => c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09 || c === 0x0c || c === 0x00;
const isDelim = (c: number) => isWs(c) || c === 0x28 || c === 0x29 || c === 0x3c || c === 0x3e || c === 0x5b || c === 0x5d || c === 0x2f || c === 0x7b || c === 0x7d || c === 0x25;

export function stripTextOps(src: Uint8Array): Uint8Array {
  const out: number[] = [];
  let i = 0;
  let inText = false;
  const n = src.length;
  const keep = (from: number, to: number) => {
    if (!inText) for (let k = from; k < to; k++) out.push(src[k]);
  };
  while (i < n) {
    const c = src[i];
    if (c === 0x28) {
      // literal string with nesting and escapes
      const start = i;
      let depth = 0;
      do {
        if (src[i] === 0x5c) i += 2;
        else {
          if (src[i] === 0x28) depth++;
          else if (src[i] === 0x29) depth--;
          i++;
        }
      } while (i < n && depth > 0);
      keep(start, i);
    } else if (c === 0x3c && src[i + 1] !== 0x3c) {
      const start = i;
      while (i < n && src[i] !== 0x3e) i++;
      i++;
      keep(start, i);
    } else if (c === 0x25) {
      const start = i;
      while (i < n && src[i] !== 0x0a && src[i] !== 0x0d) i++;
      keep(start, i);
    } else if (!isDelim(c)) {
      const start = i;
      while (i < n && !isDelim(src[i])) i++;
      const len = i - start;
      const tok = len <= 2 ? String.fromCharCode(...src.subarray(start, i)) : "";
      if (tok === "BT") {
        inText = true;
        continue;
      }
      if (tok === "ET" && inText) {
        inText = false;
        continue;
      }
      if (tok === "ID" && !inText) {
        // Inline image data: copy raw bytes up to the EI operator.
        keep(start, i);
        const dataStart = i;
        while (i < n - 2 && !(isWs(src[i]) && src[i + 1] === 0x45 && src[i + 2] === 0x49 && (i + 3 >= n || isDelim(src[i + 3])))) i++;
        keep(dataStart, i);
        continue;
      }
      keep(start, i);
    } else {
      keep(i, i + 1);
      i++;
    }
  }
  return new Uint8Array(out);
}

function streamBytes(s: PDFStream): Uint8Array | null {
  if (s instanceof PDFRawStream) {
    try {
      return decodePDFRawStream(s).decode();
    } catch {
      return null;
    }
  }
  try {
    return s.getContents();
  } catch {
    return null;
  }
}

export async function withoutText(bytes: Uint8Array): Promise<Uint8Array> {
  const { doc } = await openForEdit(bytes);
  const ctx = doc.context;
  const targets = new Set<PDFRef>();
  for (const page of doc.getPages()) {
    const contents = page.node.get(PDFName.of("Contents"));
    if (contents instanceof PDFRef) targets.add(contents);
    else if (contents instanceof PDFArray) contents.asArray().forEach((r) => r instanceof PDFRef && targets.add(r));
  }
  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    if (obj instanceof PDFStream && obj.dict.get(PDFName.of("Subtype")) === PDFName.of("Form")) targets.add(ref);
  }
  for (const ref of targets) {
    const s = ctx.lookup(ref);
    if (!(s instanceof PDFStream)) continue;
    const raw = streamBytes(s);
    if (!raw) continue;
    const stripped = zlibSync(stripTextOps(raw));
    const dict = s.dict.clone(ctx) as PDFDict;
    dict.set(PDFName.of("Filter"), PDFName.of("FlateDecode"));
    dict.delete(PDFName.of("DecodeParms"));
    ctx.assign(ref, PDFRawStream.of(dict, stripped));
  }
  return doc.save({ addDefaultPage: false });
}
