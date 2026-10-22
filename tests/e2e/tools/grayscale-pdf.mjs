// Grayscale PDF: no RGB colour operator or RGB image left, text kept.
import { readFileSync } from "node:fs";
import { PDFDocument, PDFName, PDFRawStream, decodePDFRawStream } from "pdf-lib";
import { must } from "./lib.mjs";

async function colour(path) {
  const doc = await PDFDocument.load(readFileSync(path));
  for (const [, o] of doc.context.enumerateIndirectObjects()) {
    if (!(o instanceof PDFRawStream)) continue;
    if (String(o.dict.get(PDFName.of("Subtype"))) === "/Image") {
      if (/RGB|CMYK/.test(String(o.dict.get(PDFName.of("ColorSpace"))))) return "RGB image";
      continue;
    }
    let s;
    try { s = Buffer.from(decodePDFRawStream(o).decode()).toString("latin1"); } catch { continue; }
    if (/(^|\s)[\d.]+\s+[\d.]+\s+[\d.]+\s+(rg|RG)(\s|$)/.test(s)) return "rg operator";
  }
  return null;
}

const spec = {
  slug: "grayscale-pdf",
  files: ["photo-page.pdf"],
  variants: {
    defaults: {
      check: async (r) => {
        must(r.type === "pdf" && r.pages === 1 && /Receipt/.test(r.text), `${r.type} ${r.pages}p`);
        const left = await colour(r.path);
        must(!left, `colour left: ${left}`);
      },
    },
  },
};
export default spec;
