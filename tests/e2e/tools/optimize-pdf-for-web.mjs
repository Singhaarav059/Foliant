// Optimize PDF for web: the file comes back linearized, pages and text unchanged.
import { readFileSync } from "node:fs";
import { must } from "./lib.mjs";

const spec = {
  slug: "optimize-pdf-for-web",
  files: ["report.pdf"],
  variants: {
    defaults: {
      check: (r) => {
        must(r.type === "pdf" && r.pages === 3 && /Quarterly/.test(r.text), `${r.type} ${r.pages}p`);
        must(/\/Linearized/.test(readFileSync(r.path).subarray(0, 2048).toString("latin1")), "not linearized");
      },
    },
  },
};
export default spec;
