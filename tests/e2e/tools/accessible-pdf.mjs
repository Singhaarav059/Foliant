// Make PDF accessible: the report comes back tagged, with a language and a title.
import { readFileSync } from "node:fs";
import { PDFDocument, PDFName } from "pdf-lib";
import { must } from "./lib.mjs";

const spec = {
  slug: "accessible-pdf",
  files: ["report.pdf"],
  variants: {
    defaults: {
      check: async (r) => {
        must(r.type === "pdf" && r.pages === 3 && /Quarterly/.test(r.text), `${r.type} ${r.pages}p`);
        const d = await PDFDocument.load(readFileSync(r.path));
        must(d.catalog.has(PDFName.of("StructTreeRoot")), "no structure tree");
        must(d.catalog.lookup(PDFName.of("Lang"))?.decodeText() === "en", "no language");
        must(!!d.getTitle(), "no title");
      },
    },
  },
};
export default spec;
