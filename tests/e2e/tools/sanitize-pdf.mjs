// Sanitize PDF: the form keeps its page but loses metadata; with forms on, its fields too.
import { readFileSync } from "node:fs";
import { must } from "./lib.mjs";

const spec = {
  slug: "sanitize-pdf",
  files: ["report.pdf"],
  variants: {
    defaults: {
      check: (r) => {
        const s = readFileSync(r.path).toString("latin1");
        must(r.type === "pdf" && r.pages === 3 && /Quarterly/.test(r.text), `${r.type} ${r.pages}p`);
        must(!/\/(JavaScript|OpenAction|Producer|Creator)\b/.test(s) && !/<x:xmpmeta/.test(s), "scripts or metadata left");
      },
    },
    "flatten forms": {
      files: ["form.pdf"],
      set: (h) => h.toggle("sanForms"),
      check: (r) => must(r.type === "pdf" && r.fields.length === 0, `${r.type} fields ${r.fields}`),
    },
  },
};
export default spec;
