// Scan to PDF (from a picked photo): an A4 page by default, the photo's own size with "fit".
import { must } from "./lib.mjs";

const spec = {
  slug: "scan-to-pdf",
  files: ["photo.jpg"],
  variants: {
    defaults: {
      check: (r) => {
        must(r.type === "pdf" && r.pages === 1, `${r.type} ${r.pages}p`);
        must(r.size[0].join("x") === "595x842", `page ${r.size[0].join("x")}, expected A4`);
        must(r.xobjects[0] > 0, "no image on the page");
      },
    },
    "colour, fit": {
      set: async (h) => { await h.radio("filter", 2); await h.radio("pageSize", 0); },
      check: (r) => must(r.type === "pdf" && r.pages === 1 && r.size[0].join("x") !== "595x842", `${r.type} ${r.size?.[0]}`),
    },
  },
};
export default spec;
