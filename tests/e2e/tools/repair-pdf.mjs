// Repair PDF: a sound file passes through; a file cut off at 60% gives back what's left.
import { must } from "./lib.mjs";

const spec = {
  slug: "repair-pdf",
  files: ["report.pdf"],
  variants: {
    defaults: {
      check: (r) => must(r.type === "pdf" && r.pages === 3 && /Quarterly/.test(r.text), `${r.type} ${r.pages}p`),
    },
    "truncated file": {
      files: ["truncated.pdf"],
      check: (r) => must(r.type === "pdf" && r.pages >= 1, r.kind === "error" ? `error: ${r.text}` : `${r.type} ${r.pages}p`),
    },
  },
};
export default spec;
