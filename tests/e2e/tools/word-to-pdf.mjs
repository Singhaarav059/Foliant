// Word to PDF: Automatic (LibreOffice on a desktop) writes a PDF; Standard lays the
// file out in a sandboxed print preview where the file's own scripts never run.
import { must } from "./lib.mjs";

const TEXT = /Project brief/;
const spec = {
  slug: "word-to-pdf",
  files: ["brief.docx"],
  timeout: 240000,
  variants: {
    defaults: {
      check: (r) => {
        must(r.type === "pdf" && r.pages >= 1, r.kind === "error" ? `error: ${r.text}` : `${r.kind} ${r.type}, expected a PDF`);
        must(TEXT.test(r.text), `text: ${r.text.slice(0, 80)}`);
      },
    },
    standard: {
      set: (h) => h.radio("fidelity", 1),
      check: (r) => {
        must(r.kind === "print", `${r.kind}, expected the print preview`);
        must(TEXT.test(r.text), `text: ${r.text.slice(0, 80)}`);
        must(!r.scriptRan, "a script in the file ran");
      },
    },
  },
};
export default spec;
