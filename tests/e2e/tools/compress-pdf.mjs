// Compress PDF: a scan comes back as a smaller one-page PDF at both levels.
import { statSync } from "node:fs";
import { must } from "./lib.mjs";

const check = (r, h) => {
  must(r.type === "pdf" && r.pages === 1, `${r.type} ${r.pages}p`);
  must(r.bytes <= statSync(h.fx("scanned.pdf")).size, `${r.bytes} bytes, larger than the input`);
};
const spec = {
  slug: "compress-pdf",
  files: ["scanned.pdf"],
  variants: {
    defaults: { check },
    extreme: { set: (h) => h.radio("level", 0), check },
  },
};
export default spec;
