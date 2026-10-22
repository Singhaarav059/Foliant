// Remove blank pages: the report has none, so it comes back whole; a mixed file loses its blank one.
import { must } from "./lib.mjs";

const spec = {
  slug: "remove-blank-pages",
  files: ["report.pdf"],
  variants: {
    defaults: {
      check: (r) => must(r.type === "pdf" && r.pages === 3, `${r.type} ${r.pages}p`),
    },
    "a blank page": {
      files: ["with-blank.pdf"],
      check: (r) => must(r.type === "pdf" && r.pages === 2, `${r.type} ${r.pages}p`),
    },
  },
};
export default spec;
