// Remove pages: page 2 picked from the thumbnails, or page 1 typed as a range.
import { must } from "./lib.mjs";

const spec = {
  slug: "remove-pages",
  files: ["report.pdf"],
  prepare: (h) => h.waitPages(3),
  variants: {
    defaults: {
      set: (h) => h.thumb(1).click({ force: true }),
      check: (r) => {
        must(r.type === "pdf" && r.pages === 2, `${r.type} ${r.pages}p, expected 2 pages`);
        must(/part 1/.test(r.text) && !/part 2/.test(r.text), "page 2 still there");
      },
    },
    "typed range": {
      set: (h) => h.page.locator('main input[placeholder="1-3, 7"]').fill("1"),
      check: (r) => {
        must(r.type === "pdf" && r.pages === 2, `${r.type} ${r.pages}p, expected 2 pages`);
        must(!/part 1/.test(r.text) && /part 2/.test(r.text), "page 1 still there");
      },
    },
  },
};
export default spec;
