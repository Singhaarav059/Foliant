// Alternate & mix: report (3 pages) and form (1 page) → R1 F1 R2 R3.
import { must } from "./lib.mjs";

const spec = {
  slug: "alternate-mix-pdf",
  files: ["report.pdf", "form.pdf"],
  variants: {
    defaults: {
      check: (r) => must(r.type === "pdf" && r.pages === 4 && /Application form/.test(r.pageText[1]), `${r.type} ${r.pages}p: ${r.pageText?.[1]?.slice(0, 40)}`),
    },
  },
};
export default spec;
