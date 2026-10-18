// Edit PDF: a rectangle drawn on page 1 (the file grows from report.pdf's 3,463 bytes), or typed text that ends up in the file.
import { must } from "./lib.mjs";

const spec = {
  slug: "edit-pdf",
  files: ["report.pdf"],
  prepare: (h) => h.waitStage(),
  variants: {
    rectangle: {
      set: async (h) => { await h.icon("square").click(); await h.drag(0.2, 0.2, 0.6, 0.35); },
      check: (r) => must(r.type === "pdf" && r.pages === 3 && r.bytes > 3463, `${r.type} ${r.pages}p ${r.bytes} bytes`),
    },
    text: {
      set: async (h) => {
        await h.icon("type").click();
        await h.clickStage(0.3, 0.3);
        await h.page.waitForFunction(() => document.activeElement?.tagName === "TEXTAREA", null, { timeout: 5000 });
        await h.page.keyboard.type("Hello edit");
        await h.icon("mouse-pointer-2").click();
        await h.clickStage(0.9, 0.05);
      },
      check: (r) => must(r.type === "pdf" && r.pages === 3 && /Hello edit/.test(r.pageText[0]), `${r.type} ${r.pages}p, page 1: ${r.pageText?.[0].slice(0, 60)}`),
    },
  },
};
export default spec;
