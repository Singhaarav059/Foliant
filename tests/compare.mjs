// Compare: pages are lined up by content before diffing, so an inserted or
// removed page is one change, not a change on every page after it. A file
// that can't be read is an error that names it, never "no differences".
//
//   node tests/compare.mjs
import { PDFDocument, StandardFonts } from "pdf-lib";
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

console.log(results.failed ? `\n${results.failed} failed` : "\nall passed");
process.exit(results.failed ? 1 : 0);
