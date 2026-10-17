// How big each image is drawn, from the page content streams. Compress uses
// it to downsample by real resolution (pixels per inch on the page), the way
// Ghostscript's pdfwrite does, instead of by pixel count.

import { PDFArray, PDFDict, PDFName, PDFNumber, PDFRawStream, PDFRef, type PDFDocument } from "pdf-lib";
import { contentBytes, tokens } from "./content";

type M = [number, number, number, number, number, number];
const mul = (m: M, n: M): M => [
  m[0] * n[0] + m[1] * n[2], m[0] * n[1] + m[1] * n[3],
  m[2] * n[0] + m[3] * n[2], m[2] * n[1] + m[3] * n[3],
  m[4] * n[0] + m[5] * n[2] + n[4], m[4] * n[1] + m[5] * n[3] + n[5],
];

// Largest drawn size of each image, in points, keyed by its object reference.
export type Placements = Map<string, { w: number; h: number }>;

export function placements(doc: PDFDocument): Placements {
  const out: Placements = new Map();
  const ctx = doc.context;
  const seenForms = new Map<string, number>();

  const walk = (streams: Uint8Array[], resources: PDFDict | undefined, start: M, depth: number) => {
    const xobjects = resources?.lookupMaybe(PDFName.of("XObject"), PDFDict);
    let ctm = start;
    const stack: M[] = [];
    let operands: (number | string | null)[] = [];
    for (const bytes of streams) {
      for (const t of tokens(bytes)) {
        if ("num" in t) { operands.push(t.num); continue; }
        if ("name" in t) { operands.push(t.name); continue; }
        if (!("op" in t)) { operands.push(null); continue; }
        switch (t.op) {
          case "q": stack.push(ctm); break;
          case "Q": ctm = stack.pop() ?? ctm; break;
          case "cm": {
            const m = operands.slice(-6);
            if (m.length === 6 && m.every((v) => typeof v === "number")) ctm = mul(m as M, ctm);
            break;
          }
          case "Do": {
            const name = operands[operands.length - 1];
            if (typeof name !== "string" || !xobjects) break;
            const ref = xobjects.get(PDFName.of(name));
            const x = ref instanceof PDFRef ? ctx.lookup(ref) : ref;
            if (!(x instanceof PDFRawStream) || !(ref instanceof PDFRef)) break;
            const sub = x.dict.get(PDFName.of("Subtype"));
            if (sub === PDFName.of("Image")) {
              const w = Math.hypot(ctm[0], ctm[1]);
              const h = Math.hypot(ctm[2], ctm[3]);
              const key = ref.toString();
              const prev = out.get(key);
              out.set(key, { w: Math.max(prev?.w ?? 0, w), h: Math.max(prev?.h ?? 0, h) });
            } else if (sub === PDFName.of("Form") && depth < 12) {
              // The same form at the same scale only needs walking once.
              const key = `${ref.toString()}@${Math.hypot(ctm[0], ctm[1]).toFixed(1)}`;
              if ((seenForms.get(key) ?? 0) > 0) break;
              seenForms.set(key, 1);
              const matrix = x.dict.lookupMaybe(PDFName.of("Matrix"), PDFArray);
              const fm = matrix?.asArray().map((v) => (v instanceof PDFNumber ? v.asNumber() : 0)) as M | undefined;
              const own = x.dict.lookupMaybe(PDFName.of("Resources"), PDFDict);
              walk(contentBytes(x, doc), own ?? resources, fm?.length === 6 ? mul(fm, ctm) : ctm, depth + 1);
            }
            break;
          }
        }
        operands = [];
      }
    }
  };

  for (const page of doc.getPages()) {
    // Resources are inheritable from parent page-tree nodes.
    let node: PDFDict | undefined = page.node;
    let resources: PDFDict | undefined;
    while (node && !resources) {
      resources = node.lookupMaybe(PDFName.of("Resources"), PDFDict);
      node = node.lookupMaybe(PDFName.of("Parent"), PDFDict);
    }
    walk(contentBytes(page.node.get(PDFName.of("Contents")), doc), resources, [1, 0, 0, 1, 0, 0], 0);
  }
  return out;
}
