// Compare: pages are lined up by content before diffing, so an inserted or
// removed page is one change, not a change on every page after it. A file
// that can't be read is an error that names it, never "no differences".
//
//   node tests/compare.mjs
import { PDFDocument, PDFName, StandardFonts, degrees } from "pdf-lib";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { load, root, check, eq } from "./lib/load.mjs";

// pdf.js runs its worker in-process here.
globalThis.pdfjsWorker = await import("pdfjs-dist/legacy/build/pdf.worker.mjs");

const { textDiff } = await load("compare");
const results = { failed: 0 };
const test = check(results);

const TEXT = {
  intro: "Introduction to the quarterly report covering revenue growth across all regions and markets",
  costs: "Operating costs fell by eight percent as hosting contracts were renegotiated in the spring",
  hiring: "Hiring plans for next year include four engineers two designers and one support lead",
  outlook: "Outlook for the coming year remains cautious given currency risk and supplier delays",
  cover: "Cover letter from the finance team summarising the changes since the previous edition",
};

async function pdf(name, pages) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const text of pages) {
    const page = doc.addPage([420, 300]);
    const words = text.split(" ");
    for (let line = 0; line * 6 < words.length; line++) {
      page.drawText(words.slice(line * 6, line * 6 + 6).join(" "), { x: 20, y: 260 - line * 18, size: 12, font });
    }
  }
  return new File([await doc.save()], name, { type: "application/pdf" });
}

// Rows that aren't unchanged. Works on the old per-index shape too, so the
// test reports a count on code without alignment.
const changed = (rows) => rows.filter((r) => (r.status ? r.status !== "same" : r.added || r.removed));

await test("one page inserted at the front is one change", async () => {
  const a = await pdf("a.pdf", [TEXT.intro, TEXT.costs, TEXT.hiring]);
  const b = await pdf("b.pdf", [TEXT.cover, TEXT.intro, TEXT.costs, TEXT.hiring]);
  const rows = await textDiff(a, b);
  eq(changed(rows).length, 1, "changes");
  const added = rows.filter((r) => r.status === "added");
  eq(added.length, 1, "added pages");
  eq(added[0].b, 0, "added page is the revised file's first");
  eq(rows.filter((r) => r.status === "same").length, 3, "unchanged pages");
  eq(rows.filter((r) => r.status === "same").map((r) => `${r.a}:${r.b}`).join(), "0:1,1:2,2:3", "pairs");
});

await test("one page removed from the middle is one change", async () => {
  const a = await pdf("a.pdf", [TEXT.intro, TEXT.costs, TEXT.hiring, TEXT.outlook]);
  const b = await pdf("b.pdf", [TEXT.intro, TEXT.hiring, TEXT.outlook]);
  const rows = await textDiff(a, b);
  eq(changed(rows).length, 1, "changes");
  const removed = rows.find((r) => r.status === "removed");
  eq(removed?.a, 1, "removed page");
  eq(removed.removed, TEXT.costs.split(" ").length, "removed words");
});

await test("an edited page stays paired with its original", async () => {
  const a = await pdf("a.pdf", [TEXT.intro, TEXT.costs, TEXT.hiring]);
  const b = await pdf("b.pdf", [TEXT.intro, TEXT.costs.replace("eight", "nine"), TEXT.hiring]);
  const rows = await textDiff(a, b);
  eq(changed(rows).length, 1, "changes");
  const row = changed(rows)[0];
  eq(`${row.status} ${row.a}:${row.b} +${row.added} -${row.removed}`, "changed 1:1 +1 -1", "row");
});

await test("a page rewritten in place is shown as one changed page", async () => {
  const a = await pdf("a.pdf", [TEXT.intro, TEXT.costs, TEXT.hiring]);
  const b = await pdf("b.pdf", [TEXT.intro, TEXT.outlook, TEXT.hiring]);
  const rows = await textDiff(a, b);
  eq(changed(rows).map((r) => `${r.status} ${r.a}:${r.b}`).join(), "changed 1:1", "rows");
});

await test("identical files have no changes", async () => {
  const a = await pdf("a.pdf", [TEXT.intro, TEXT.costs]);
  eq(changed(await textDiff(a, await pdf("b.pdf", [TEXT.intro, TEXT.costs]))).length, 0, "changes");
});

await test("an unreadable file is an error naming it, not an empty diff", async () => {
  const ok = new File([readFileSync(join(root, "tests/fixtures/report.pdf"))], "report.pdf", { type: "application/pdf" });
  const locked = new File([readFileSync(join(root, "tests/fixtures/locked-report.pdf"))], "locked-report.pdf", { type: "application/pdf" });
  const text = new File([readFileSync(join(root, "tests/fixtures/text-file.pdf"))], "text-file.pdf", { type: "application/pdf" });
  for (const [a, b, code, name] of [[locked, ok, "encrypted", "locked-report.pdf"], [ok, text, "not_pdf", "text-file.pdf"]]) {
    let error = null;
    try {
      await textDiff(a, b);
    } catch (e) {
      error = e;
    }
    if (!error) throw new Error(`${a.name} vs ${b.name}: no error`);
    eq(`${error.code} ${error.fileName}`, `${code} ${name}`, `${a.name} vs ${b.name}`);
  }
});

// ── Exporting the differences (src/lib/pdf/compare-export.ts)

const { annotatedCopy, changeReport } = await load("compare-export");
// Keys and values, so the test reads what the export asked to say.
const say = (key, vars) => (vars ? `${key} ${JSON.stringify(vars)}` : key);

// Every annotation in a PDF: its page, subtype and dictionary.
async function annotations(blob) {
  const doc = await PDFDocument.load(new Uint8Array(await blob.arrayBuffer()));
  return doc.getPages().flatMap((page, i) =>
    (page.node.Annots()?.asArray() ?? []).map((ref) => {
      const dict = doc.context.lookup(ref);
      return { page: i, subtype: dict.get(PDFName.of("Subtype"))?.toString(), dict };
    }),
  );
}
const numbers = (dict, key) => dict.get(PDFName.of(key))?.asArray().map((n) => n.asNumber()) ?? [];

await test("export: one word changed is one highlight over it, and a one-change report", async () => {
  const revised = TEXT.costs.replace("eight", "nine");
  const a = await pdf("report <draft>.pdf", [TEXT.intro, TEXT.costs, TEXT.hiring]);
  const b = await pdf("report-final.pdf", [TEXT.intro, revised, TEXT.hiring]);
  const rows = await textDiff(a, b);
  eq(changed(rows).length, 1, "changes");

  const copy = await annotatedCopy(b, rows, say);
  eq(copy.name, "report-final-changes.pdf", "file name");
  const all = await annotations(copy.blob);
  const marks = all.filter((x) => x.subtype === "/Highlight");
  eq(marks.length, 1, `highlights (all: ${all.map((x) => x.subtype).join()})`);
  eq(marks[0].page, 1, "on the changed page");
  // Over "nine": the words before it end where it starts (Helvetica 12 at x = 20, baseline 260).
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const x0 = 20 + font.widthOfTextAtSize("Operating costs fell by ", 12);
  const x1 = x0 + font.widthOfTextAtSize("nine", 12);
  const quad = numbers(marks[0].dict, "QuadPoints");
  eq(quad.length, 8, "one quad");
  const xs = quad.filter((_, i) => i % 2 === 0);
  const ys = quad.filter((_, i) => i % 2 === 1);
  if (Math.abs(Math.min(...xs) - x0) > 1.5 || Math.abs(Math.max(...xs) - x1) > 1.5) throw new Error(`x ${Math.min(...xs)}–${Math.max(...xs)}, expected ${x0}–${x1}`);
  if (!(Math.min(...ys) < 260 && Math.max(...ys) > 268)) throw new Error(`y ${Math.min(...ys)}–${Math.max(...ys)} misses the baseline at 260`);
  const contents = marks[0].dict.get(PDFName.of("Contents"))?.decodeText();
  eq(contents, 'cmp.noteReplaced {"old":"eight"}', "note");
  // Viewers that don't draw annotations themselves get an appearance.
  eq(!!marks[0].dict.get(PDFName.of("AP")), true, "appearance stream");

  const report = changeReport(a, b, rows, say, new Date("2026-10-18T09:30:00Z"));
  eq(report.name, "report-final-changes.html", "report name");
  const html = await report.blob.text();
  eq((html.match(/<section data-change/g) ?? []).length, 1, "changes in the report");
  eq(/<del>eight<\/del>/.test(html) && /<ins>nine<\/ins>/.test(html), true, "old and new words");
  eq(html.includes("report &lt;draft&gt;.pdf") && !html.includes("<draft>"), true, "file names escaped");
  eq(/https?:\/\//.test(html.replace(/<!--[\s\S]*?-->/g, "")), false, "loads nothing from anywhere");
});

await test("export: the highlight lands on the word on a rotated page too", async () => {
  const turn = async (file) => {
    const doc = await PDFDocument.load(new Uint8Array(await file.arrayBuffer()));
    for (const page of doc.getPages()) page.setRotation(degrees(90));
    return new File([await doc.save()], file.name, { type: "application/pdf" });
  };
  const a = await turn(await pdf("a.pdf", [TEXT.costs]));
  const b = await turn(await pdf("b.pdf", [TEXT.costs.replace("eight", "nine")]));
  const [mark] = (await annotations((await annotatedCopy(b, await textDiff(a, b), say)).blob)).filter((x) => x.subtype === "/Highlight");
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const x0 = 20 + font.widthOfTextAtSize("Operating costs fell by ", 12);
  const quad = numbers(mark.dict, "QuadPoints");
  const xs = quad.filter((_, i) => i % 2 === 0);
  const ys = quad.filter((_, i) => i % 2 === 1);
  // Same place in the page's own (unrotated) space.
  if (Math.abs(Math.min(...xs) - x0) > 1.5 || !(Math.min(...ys) < 260 && Math.max(...ys) > 268)) throw new Error(`quad ${quad.map((n) => n.toFixed(1)).join(" ")}`);
});

await test("export: added and removed words, and an added page", async () => {
  const a = await pdf("a.pdf", [TEXT.intro, TEXT.costs]);
  const b = await pdf("b.pdf", [TEXT.cover, TEXT.intro.replace("revenue growth ", ""), TEXT.costs.replace("spring", "spring and summer")]);
  const rows = await textDiff(a, b);
  const all = await annotations((await annotatedCopy(b, rows, say)).blob);
  const kinds = all.map((x) => `${x.page}:${x.subtype}:${x.dict.get(PDFName.of("Contents"))?.decodeText()}`).sort();
  eq(kinds.join(" | "), [
    "0:/Text:cmp.notePageAdded",
    '1:/Text:cmp.noteRemoved {"old":"revenue growth"}',
    "2:/Highlight:cmp.noteAdded",
  ].join(" | "), "annotations");
});

console.log(results.failed ? `\n${results.failed} failed` : "\nall passed");
process.exit(results.failed ? 1 : 0);
