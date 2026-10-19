// Rotate PDF: every page turned 90° by default, or 180°.
import { must } from "./lib.mjs";

const turned = (a) => (r) => must(r.type === "pdf" && r.rot.join() === [a, a, a].join(), `${r.type} rotations ${r.rot}, expected ${a}°`);
const spec = {
  slug: "rotate-pdf",
  files: ["report.pdf"],
  prepare: (h) => h.waitPages(3),
  variants: {
    defaults: { check: turned(90) },
    "180°": { set: (h) => h.select("angle", "180"), check: turned(180) },
  },
};
export default spec;
