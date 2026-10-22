// Flatten PDF: the form's fields are gone, the page stays.
import { must } from "./lib.mjs";

const spec = {
  slug: "flatten-pdf",
  files: ["form.pdf"],
  variants: {
    defaults: {
      check: (r) => must(r.type === "pdf" && r.pages === 1 && r.fields.length === 0 && /Application form/.test(r.text), `${r.type} fields ${r.fields}`),
    },
    "forms only": {
      set: (h) => h.radio("flattenWhat", 1),
      check: (r) => must(r.type === "pdf" && r.fields.length === 0, `${r.type} fields ${r.fields}`),
    },
  },
};
export default spec;
