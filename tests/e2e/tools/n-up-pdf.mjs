// N-up PDF: the 3-page report on two sheets, two to a landscape sheet; four to a sheet on one.
import { must } from "./lib.mjs";

const spec = {
  slug: "n-up-pdf",
  files: ["report.pdf"],
  variants: {
    defaults: {
      check: (r) => must(r.type === "pdf" && r.pages === 2 && r.size[0][0] > r.size[0][1] && /Quarterly/.test(r.text), `${r.type} ${r.pages}p ${r.size?.[0]}`),
    },
    "4 per sheet, A4": {
      set: async (h) => { await h.radio("nupPages", 1); await h.radio("sheetSize", 1); },
      check: (r) => must(r.type === "pdf" && r.pages === 1 && r.size[0].join("x") === "595x842", `${r.type} ${r.pages}p ${r.size?.[0]}`),
    },
  },
};
export default spec;
