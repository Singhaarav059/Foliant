// OCR PDF: the scan gets a text layer that reads "Invoice 4471", with either engine.
import { must } from "./lib.mjs";

const check = (r) => {
  must(r.type === "pdf" && r.pages === 1, `${r.type} ${r.pages}p`);
  must(/invoice\s*4471/i.test(r.text), `text: ${r.text?.slice(0, 80)}`);
};
const spec = {
  slug: "ocr-pdf",
  files: ["scanned.pdf"],
  timeout: 240000,
  variants: {
    defaults: { check },
    "accurate engine": { set: (h) => h.radio("ocrEngine", 1), check },
  },
};
export default spec;
