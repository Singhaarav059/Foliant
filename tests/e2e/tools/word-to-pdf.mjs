// Word to PDF: Automatic (LibreOffice on a desktop) writes a PDF; Standard draws the
// file as a PDF in the browser, with no print dialog and no LibreOffice download.
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
        must(r.type === "pdf" && r.pages >= 1, r.kind === "error" ? `error: ${r.text}` : `${r.kind} ${r.type}, expected a PDF`);
        must(TEXT.test(r.text), `text: ${r.text.slice(0, 80)}`);
      },
    },
  },
};
export default spec;
