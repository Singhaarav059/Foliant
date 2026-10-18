// PDF to Excel: the report's table in a sheet per page, or all in one sheet.
import { must } from "./lib.mjs";

const table = (r) => must(/North/.test(r.text) && /2,?210/.test(r.text), `text: ${r.text?.slice(0, 80)}`);
const spec = {
  slug: "pdf-to-excel",
  files: ["report.pdf"],
  variants: {
    defaults: {
      check: (r) => {
        must(r.type === "xlsx" && r.sheets === 3, `${r.type} ${r.sheets} sheets, expected 3`);
        table(r);
      },
    },
    "one sheet": {
      set: (h) => h.radio("sheetPer", 1),
      check: (r) => {
        must(r.type === "xlsx" && r.sheets === 1, `${r.type} ${r.sheets} sheets, expected 1`);
        table(r);
      },
    },
  },
};
export default spec;
