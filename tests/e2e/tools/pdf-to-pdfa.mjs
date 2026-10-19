// PDF to PDF/A: an archival file (PDF/A identification in its metadata), at
// the default level and at 1b. Pages that need no rasterising keep their real text.
import { must } from "./lib.mjs";

const spec = {
  slug: "pdf-to-pdfa",
  files: ["report.pdf"],
  timeout: 120000,
  variants: {
    defaults: {
      check: (r) => {
        must(r.type === "pdf" && r.pages === 3 && r.pdfa, `${r.type} ${r.pages}p pdfa=${r.pdfa}`);
        must(/Quarterly report part 1/.test(r.text), "text not kept");
      },
    },
    // The DPI and text-layer options only show when a page must become an
    // image; report.pdf needs none, so the level is what changes here.
    "PDF/A-1b": {
      set: (h) => h.select("pdfaLevel", "1b"),
      check: (r) => {
        must(r.type === "pdf" && r.pages === 3 && r.pdfa, `${r.type} ${r.pages}p pdfa=${r.pdfa}`);
        must(/Quarterly report part 3/.test(r.text), "real text lost");
      },
    },
  },
};
export default spec;
