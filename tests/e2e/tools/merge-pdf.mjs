// Merge PDF: two 3-page reports become one 6-page file, with bookmarks unless turned off.
import { must } from "./lib.mjs";

const spec = {
  slug: "merge-pdf",
  files: ["report.pdf", "report-v2.pdf"],
  variants: {
    defaults: {
      check: (r) => {
        must(r.type === "pdf" && r.pages === 6, `${r.type} ${r.pages}p, expected a 6-page PDF`);
        must(r.outline, "no bookmarks");
        must(/2,210.*2,500/.test(r.text), "pages not in file order");
      },
    },
    "no bookmarks": {
      set: (h) => h.toggle("bookmarks"),
      check: (r) => {
        must(r.type === "pdf" && r.pages === 6, `${r.type} ${r.pages}p, expected a 6-page PDF`);
        must(!r.outline, "has bookmarks");
      },
    },
  },
};
export default spec;
