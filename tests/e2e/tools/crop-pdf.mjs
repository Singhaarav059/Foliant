// Crop PDF: auto-crop trims every page to its content; a box drawn with
// "current page" crops page 1 only.
import { must } from "./lib.mjs";

const full = (c) => c.join() === "0,0,595,842";
const spec = {
  slug: "crop-pdf",
  files: ["report.pdf"],
  prepare: (h) => h.waitStage(),
  variants: {
    "defaults (auto-crop)": {
      set: (h) => h.icon("crop", "main aside").click(),
      check: (r) => must(r.type === "pdf" && r.pages === 3 && r.crop.every((c) => !full(c)), `${r.type} crop boxes ${JSON.stringify(r.crop)}`),
    },
    "current page": {
      set: async (h) => { await h.radio("cropScope", 1); await h.drag(0.1, 0.1, 0.8, 0.6); },
      check: (r) => must(r.type === "pdf" && r.pages === 3 && !full(r.crop[0]) && full(r.crop[1]), `${r.type} crop boxes ${JSON.stringify(r.crop)}`),
    },
  },
};
export default spec;
