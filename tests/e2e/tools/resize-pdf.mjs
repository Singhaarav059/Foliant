// Resize PDF pages: every page comes out A4 (the default) or US Letter, text kept.
import { must } from "./lib.mjs";

const spec = {
  slug: "resize-pdf",
  files: ["report.pdf"],
  variants: {
    defaults: {
      check: (r) => must(r.type === "pdf" && r.pages === 3 && r.size.every(([w, h]) => w === 595 && h === 842) && /Quarterly/.test(r.text), `${r.type} ${r.size}`),
    },
    letter: {
      set: (h) => h.select("pageSize", "letter"),
      check: (r) => must(r.type === "pdf" && r.size.every(([w, h]) => w === 612 && h === 792), `${r.type} ${r.size}`),
    },
  },
};
export default spec;
