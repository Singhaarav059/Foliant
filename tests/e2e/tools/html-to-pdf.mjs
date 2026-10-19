// HTML to PDF (an uploaded file): a sandboxed print preview of the page, in
// A4 portrait or Letter landscape, where the page's own script never runs.
import { must } from "./lib.mjs";

const check = (r) => {
  must(r.kind === "print", `${r.kind}, expected the print preview`);
  must(/Hello HTML fixture/.test(r.text), `text: ${r.text?.slice(0, 80)}`);
  must(!r.scriptRan, "the page's script ran");
};
const spec = {
  slug: "html-to-pdf",
  files: ["page.html"],
  variants: {
    defaults: { check },
    "letter landscape": { set: async (h) => { await h.radio("pageSize", 1); await h.radio("orientation", 1); }, check },
  },
};
export default spec;
