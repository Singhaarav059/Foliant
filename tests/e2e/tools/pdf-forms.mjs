// PDF forms: the filled name and checkbox are saved in the fields, or
// flattened into the page with no fields left.
import { must } from "./lib.mjs";

const spec = {
  slug: "pdf-forms",
  files: ["form.pdf"],
  prepare: async (h) => {
    await h.waitStage();
    const field = (name) => h.page.locator("main aside label").filter({ has: h.page.locator(`span[title="${name}"]`) });
    await field("fullName").locator("input").fill("Ada Lovelace");
    await field("agree").locator("input").check();
  },
  variants: {
    defaults: {
      check: (r) => {
        must(r.type === "pdf" && r.pages === 1, `${r.type} ${r.pages}p`);
        must(r.values.fullName === "Ada Lovelace", `fullName = ${JSON.stringify(r.values.fullName)}`);
        must(r.values.agree === true, "agree not checked");
      },
    },
    flatten: {
      set: (h) => h.toggle("flatten"),
      check: (r) => {
        must(r.type === "pdf" && r.pages === 1 && r.fields.length === 0, `${r.type} fields ${r.fields}`);
        must(/Ada Lovelace/.test(r.text), "the name isn't on the page");
      },
    },
  },
};
export default spec;
