// Add header and footer: the default footer "{page} / {pages}" and a typed header land on every page.
import { must } from "./lib.mjs";

const spec = {
  slug: "add-header-footer",
  files: ["report.pdf"],
  variants: {
    defaults: {
      check: (r) => must(r.type === "pdf" && /1 \/ 3/.test(r.pageText[0]) && /3 \/ 3/.test(r.pageText[2]), `${r.type}: ${r.pageText?.[0]?.slice(-40)}`),
    },
    header: {
      set: (h) => h.fill("hfHeader", "Board pack {filename}"),
      check: (r) => must(r.type === "pdf" && r.pageText.every((t) => /Board pack report/.test(t)), `${r.type}: ${r.pageText?.[0]?.slice(0, 60)}`),
    },
  },
};
export default spec;
