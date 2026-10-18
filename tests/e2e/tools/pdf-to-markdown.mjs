// PDF to Markdown: headings and text, with page breaks marked when asked.
import { must } from "./lib.mjs";

const spec = {
  slug: "pdf-to-markdown",
  files: ["report.pdf"],
  variants: {
    defaults: {
      check: (r) => {
        must(r.type === "md", `${r.type}, expected md`);
        must(/^#+ Quarterly report part 1$/m.test(r.text), "no heading");
        must(!/<!-- page 2 -->/.test(r.text), "page breaks marked");
      },
    },
    "page breaks": {
      set: (h) => h.toggle("pageBreaks"),
      check: (r) => must(r.type === "md" && /^---$/m.test(r.text) && /<!-- page 3 -->/.test(r.text), "no page breaks"),
    },
  },
};
export default spec;
