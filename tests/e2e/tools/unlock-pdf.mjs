// Unlock PDF: the file Protect PDF made opens with its password; a wrong one is refused.
import { must } from "./lib.mjs";
import { PASSWORD } from "./protect-pdf.mjs";

const spec = {
  slug: "unlock-pdf",
  after: "protect-pdf",
  files: ["@protected"],
  variants: {
    defaults: {
      set: (h) => h.fill("password", PASSWORD),
      check: (r) => must(r.type === "pdf" && r.encrypted === false && r.pages === 3 && /Quarterly/.test(r.text), `${r.kind} ${r.type} encrypted=${r.encrypted}`),
    },
    "wrong password": {
      set: (h) => h.fill("password", "wrong-pass"),
      check: (r) => must(r.kind === "error", `${r.kind}, expected an error`),
    },
  },
};
export default spec;
