// Split PDF: the default ranges fit the file (1-2, 3 for three pages) and
// give two files; "every 1 page" gives three; bookmarks give one file per
// chapter, named after it; a size in KB keeps every part under it.
import { PDFDocument, PDFHexString, PDFName, PDFNumber, StandardFonts } from "pdf-lib";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { must } from "./lib.mjs";

// Six pages with a photo each (about 12 KB a page) and a bookmark on pages 1, 3 and 5.
async function chapters() {
  const doc = await PDFDocument.create();
  const ctx = doc.context;
  const font = await doc.embedFont(StandardFonts.Helvetica);
  let seed = 3;
  const pages = Array.from({ length: 6 }, (_, i) => {
    const page = doc.addPage([400, 600]);
    page.drawText(`PAGE${i + 1}`, { x: 40, y: 560, size: 14, font });
    const px = Uint8Array.from({ length: 64 * 64 * 3 }, () => ((seed = (Math.imul(seed, 1103515245) + 12345) | 0) >>> 16) & 0xff);
    page.node.setXObject(PDFName.of("Im1"), ctx.register(ctx.flateStream(px, { Type: "XObject", Subtype: "Image", Width: 64, Height: 64, ColorSpace: "DeviceRGB", BitsPerComponent: 8 })));
    page.node.addContentStream(ctx.register(ctx.stream("q 200 0 0 200 100 200 cm /Im1 Do Q")));
    return page;
  });
  const root = ctx.nextRef();
  const refs = [0, 1, 2].map(() => ctx.nextRef());
  ["Intro", "Methods", "Results"].forEach((title, i) => ctx.assign(refs[i], ctx.obj({
    Title: PDFHexString.fromText(title), Parent: root, Dest: [pages[i * 2].ref, PDFName.of("Fit")],
    ...(i ? { Prev: refs[i - 1] } : {}), ...(i < 2 ? { Next: refs[i + 1] } : {}),
  })));
  ctx.assign(root, ctx.obj({ Type: "Outlines", First: refs[0], Last: refs[2], Count: PDFNumber.of(3) }));
  doc.catalog.set(PDFName.of("Outlines"), root);
  const path = join(mkdtempSync(join(tmpdir(), "e2e-split-")), "paper.pdf");
  writeFileSync(path, await doc.save());
  return path;
}
const paper = await chapters();
// The line under an option that lists the files a split makes; its page
// numbers read the same in every language.
const note = (h, key) => h.page.locator(`main [id$="-${key}-note"]`).first().textContent({ timeout: 10000 });

const spec = {
  slug: "split-pdf",
  files: ["report.pdf"],
  variants: {
    defaults: {
      set: async (h) => {
        await h.page.waitForFunction(() => document.querySelector('main input[id$="-ranges"]')?.value === "1-2, 3", null, { timeout: 15000 });
        const line = await note(h, "ranges");
        must(line.includes("1-2, 3"), `preview "${line}"`);
      },
      check: (r) => {
        must(r.type === "zip", `${r.type}, expected a zip`);
        must(r.entries.map((e) => e.pages).join() === "2,1", `pages per file ${r.entries.map((e) => e.pages)}`);
      },
    },
    "every page": {
      set: async (h) => {
        await h.select("splitMode", "every");
        await h.fill("every", "1");
        const line = await note(h, "every");
        must(line.includes("1, 2, 3"), `preview "${line}"`);
      },
      check: (r) => {
        must(r.type === "zip" && r.entries.length === 3, `${r.type} with ${r.entries?.length} files, expected 3`);
        must(r.entries.every((e) => e.pages === 1), "a file has more than one page");
      },
    },
    bookmarks: {
      files: [paper],
      set: async (h) => { await h.select("splitMode", "bookmarks"); },
      check: (r) => {
        const got = r.entries?.map((e) => `${e.name}:${e.pages}`).join();
        must(r.type === "zip" && got === "Intro.pdf:2,Methods.pdf:2,Results.pdf:2", `${r.type}: ${got}`);
      },
    },
    "size in KB": {
      files: [paper],
      set: async (h) => {
        await h.select("splitMode", "size");
        await h.fill("maxSize", "30");
        await h.radio("sizeUnit", 1);
      },
      check: (r) => {
        must(r.type === "zip" && r.entries.length >= 3, `${r.type} with ${r.entries?.length} files, expected 3 or more`);
        must(r.entries.every((e) => e.bytes <= 30 * 1024), `sizes ${r.entries.map((e) => e.bytes)}`);
        must(r.entries.reduce((n, e) => n + e.pages, 0) === 6, "pages over all files");
      },
    },
  },
};
export default spec;
