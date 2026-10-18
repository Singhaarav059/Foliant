// PDF to PDF/A: an archival file (PDF/A identification in its metadata). Pages
// that need no rasterising keep their real text, whether or not the
// searchable layer for rasterised pages is turned off.
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
    "no text layer": {
      set: (h) => h.toggle("keepText"),
      check: (r) => {
        must(r.type === "pdf" && r.pages === 3 && r.pdfa, `${r.type} ${r.pages}p pdfa=${r.pdfa}`);
        must(/Quarterly report part 3/.test(r.text), "real text lost");
      },
    },
  },
};
export default spec;
