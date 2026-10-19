// Extract pages: pages 1 and 3 picked from the thumbnails, as one file or one file each.
import { must } from "./lib.mjs";

const spec = {
  slug: "extract-pages",
  files: ["report.pdf"],
  prepare: async (h) => {
    await h.waitPages(3);
    await h.thumb(0).click({ force: true });
    await h.thumb(2).click({ force: true });
  },
  variants: {
    defaults: {
      check: (r) => {
        must(r.type === "pdf" && r.pages === 2, `${r.type} ${r.pages}p, expected 2 pages`);
        must(/part 1/.test(r.text) && /part 3/.test(r.text) && !/part 2/.test(r.text), "wrong pages");
      },
    },
    separate: {
      set: (h) => h.toggle("separate"),
      check: (r) => must(r.type === "zip" && r.entries.length === 2 && r.entries.every((e) => e.pages === 1), `${r.type} ${JSON.stringify(r.entries)}`),
    },
  },
};
export default spec;
