// PDF bookmarks: the report's headings become an outline; Remove all takes it away again.
import { must } from "./lib.mjs";

const spec = {
  slug: "pdf-bookmarks",
  files: ["report.pdf"],
  variants: {
    defaults: {
      keep: "bookmarked",
      check: (r) => must(r.type === "pdf" && r.pages === 3 && r.outline, `${r.type} ${r.pages}p outline ${r.outline}`),
    },
    "remove all": {
      files: ["@bookmarked"],
      set: (h) => h.radio("bookmarkMode", 1),
      check: (r) => must(r.type === "pdf" && r.pages === 3 && !r.outline, `${r.type} outline ${r.outline}`),
    },
  },
};
export default spec;
