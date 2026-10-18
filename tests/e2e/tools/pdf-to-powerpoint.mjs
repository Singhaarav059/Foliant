// PDF to PowerPoint: one slide per page, with editable text unless turned off.
import { must } from "./lib.mjs";

const spec = {
  slug: "pdf-to-powerpoint",
  files: ["report.pdf"],
  variants: {
    defaults: {
      check: (r) => {
        must(r.type === "pptx" && r.slides === 3, `${r.type} ${r.slides} slides, expected 3`);
        must(/Quarterly report part 1/.test(r.text), `text: ${r.text?.slice(0, 80)}`);
      },
    },
    "no text": {
      set: (h) => h.toggle("pptText"),
      check: (r) => {
        must(r.type === "pptx" && r.slides === 3, `${r.type} ${r.slides} slides, expected 3`);
        must(!/Quarterly report/.test(r.text), "slides still have text boxes");
      },
    },
  },
};
export default spec;
