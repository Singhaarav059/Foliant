// PDF to Word: editable text by default; "exact" keeps each page as a picture.
import { must } from "./lib.mjs";

const spec = {
  slug: "pdf-to-word",
  files: ["report.pdf"],
  variants: {
    defaults: {
      check: (r) => {
        must(r.type === "docx", `${r.type}, expected docx`);
        must(/Quarterly report part 1/.test(r.text) && /jane\.doe@example\.com/.test(r.text), `text: ${r.text?.slice(0, 80)}`);
        must(/<w:tbl>/.test(r.xml), "the table didn't become a Word table");
      },
    },
    exact: {
      set: (h) => h.radio("wordMode", 1),
      check: (r) => {
        must(r.type === "docx", `${r.type}, expected docx`);
        must(/<w:drawing>/.test(r.xml) && r.names.some((n) => /^word\/media\//.test(n)), "no page pictures");
      },
    },
  },
};
export default spec;
