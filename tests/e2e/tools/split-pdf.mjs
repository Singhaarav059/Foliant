// Split PDF: the default ranges (1-2, 3-4) give two files; "every 1 page" gives three.
import { must } from "./lib.mjs";

const spec = {
  slug: "split-pdf",
  files: ["report.pdf"],
  variants: {
    defaults: {
      check: (r) => {
        must(r.type === "zip", `${r.type}, expected a zip`);
        must(r.entries.map((e) => e.pages).join() === "2,1", `pages per file ${r.entries.map((e) => e.pages)}`);
      },
    },
    "every page": {
      set: async (h) => { await h.radio("splitMode", 1); await h.fill("every", "1"); },
      check: (r) => {
        must(r.type === "zip" && r.entries.length === 3, `${r.type} with ${r.entries?.length} files, expected 3`);
        must(r.entries.every((e) => e.pages === 1), "a file has more than one page");
      },
    },
  },
};
export default spec;
