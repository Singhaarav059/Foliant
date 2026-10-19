// Protect PDF: the file comes back encrypted, also with printing turned off.
// Unlock PDF opens the default one again.
import { must } from "./lib.mjs";

export const PASSWORD = "test1234";
const spec = {
  slug: "protect-pdf",
  files: ["report.pdf"],
  prepare: async (h) => { await h.fill("password", PASSWORD); await h.fill("confirmPassword", PASSWORD); },
  variants: {
    defaults: { keep: "protected", check: (r) => must(r.type === "pdf" && r.encrypted === true, "not encrypted") },
    "no printing": { set: (h) => h.toggle("allowPrint"), check: (r) => must(r.type === "pdf" && r.encrypted === true, "not encrypted") },
  },
};
export default spec;
