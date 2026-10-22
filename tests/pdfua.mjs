// Make PDF accessible (P2-16): the tagged output has a structure tree pdf.js
// reads (headings, paragraphs, a list, a figure, a link), every text object
// sits in numbered marked content, decoration is an artifact, and the
// catalog names the language and shows the title. With VERAPDF set, veraPDF's
// PDF/UA-1 check fails fewer rules than on the untagged file, and none about
// structure or language.
//
//   [VERAPDF=/path/to/verapdf] node tests/pdfua.mjs
import { PDFDocument, PDFName, PDFDict, PDFArray, PDFRawStream, StandardFonts, rgb, decodePDFRawStream } from "pdf-lib";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { load, openPdf, check, eq, root } from "./lib/load.mjs";

globalThis.pdfjsWorker ??= await import("pdfjs-dist/legacy/build/pdf.worker.mjs");
const results = { failed: 0 };
const test = check(results);
const ok = (v, what) => {
  if (!v) throw new Error(what);
};
const { tagPdf, marks } = await load("tag");
const { runTool } = await load("run");
const asFile = (bytes, name = "in.pdf") => new File([bytes], name, { type: "application/pdf" });
const bytesOf = async (blob) => new Uint8Array(await blob.arrayBuffer());

// A heading, a subheading, two paragraphs, a bulleted list, a rule, a picture and a link.
async function fixture() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const page = doc.addPage([595, 842]);
  page.drawText("Annual report", { x: 60, y: 770, size: 26, font: bold });
  page.drawLine({ start: { x: 60, y: 755 }, end: { x: 535, y: 755 }, thickness: 1, color: rgb(0.6, 0.6, 0.6) });
  const body = "Revenue grew steadily through the year, led by new customers in the south.";
  for (let k = 0; k < 3; k++) page.drawText(body, { x: 60, y: 720 - k * 15, size: 11, font });
  page.drawText("Highlights", { x: 60, y: 660, size: 17, font: bold });
  for (const [k, item] of ["• Three new offices", "• Forty new staff", "• A new website"].entries()) page.drawText(item, { x: 70, y: 635 - k * 16, size: 11, font });
  const png = await doc.embedPng(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP4z8DwnwEIGBgYGBgAAPf8Af/sQs3wAAAAAElFTkSuQmCC", "base64"));
  page.drawImage(png, { x: 60, y: 420, width: 160, height: 120 });
  for (let k = 0; k < 2; k++) page.drawText(body, { x: 60, y: 390 - k * 15, size: 11, font });
  const link = doc.context.register(doc.context.obj({ Type: "Annot", Subtype: "Link", Rect: [60, 385, 300, 400], Border: [0, 0, 0], A: { S: "URI", URI: "https://example.com/report" } }));
  page.node.set(PDFName.of("Annots"), doc.context.obj([link]));
  return doc.save();
}

const src = await fixture();
const [out] = await tagPdf(asFile(src, "annual.pdf"), { title: "", lang: "" });
const tagged = await bytesOf(out.blob);
const doc = await PDFDocument.load(tagged);

await test("the catalog: marked, language, title shown, PDF/UA-1 claimed", () => {
  eq(String(doc.catalog.lookup(PDFName.of("MarkInfo")).get(PDFName.of("Marked"))), "true", "Marked");
  eq(doc.catalog.lookup(PDFName.of("Lang")).decodeText(), "en", "Lang");
  eq(String(doc.catalog.lookup(PDFName.of("ViewerPreferences")).get(PDFName.of("DisplayDocTitle"))), "true", "DisplayDocTitle");
  eq(doc.getTitle(), "Annual report", "title from the first heading");
  const xmp = Buffer.from(decodePDFRawStream(doc.context.lookup(doc.catalog.get(PDFName.of("Metadata")))).decode()).toString();
  ok(/<pdfuaid:part>1<\/pdfuaid:part>/.test(xmp), "pdfuaid:part");
  eq(out.note, "tagged:1:1", "note: 1 page, 1 figure");
});

await test("pdf.js reads the structure: H1, P, H2, a list of 3, a Figure, a P with its Link, in reading order", async () => {
  const pdf = await openPdf(tagged.slice());
  const tree = await (await pdf.getPage(1)).getStructTree();
  const roles = (n) => (n.role ? [n.role, ...(n.children ?? []).flatMap(roles)] : (n.children ?? []).flatMap(roles));
  const top = tree.children[0].children.map((c) => c.role);
  eq(top.join(" "), "H1 P H2 L Figure P", "top-level elements");
  eq(tree.children[0].children[5].children.filter((c) => c.role).map((c) => c.role).join(), "Link", "the link inside its paragraph");
  const list = tree.children[0].children[3];
  eq(list.children.map((c) => c.role).join(" "), "LI LI LI", "list items");
  ok(roles(tree).includes("LBody"), "list bodies");
});

await test("every text object is in numbered marked content; the rule is an artifact", () => {
  const page = doc.getPage(0);
  const s = Buffer.from(decodePDFRawStream(doc.context.lookup(page.node.get(PDFName.of("Contents")))).decode()).toString("latin1");
  const bts = s.match(/\bBT\b/g).length;
  const marked = s.match(/<<\/MCID \d+>> BDC\s*(?:q[\s\S]*?)?BT\b/g)?.length ?? 0;
  ok(bts > 0 && marked === bts, `${marked} of ${bts} text objects marked`);
  ok(/\/Artifact BMC\s[\s\S]*?\bS\b\s*EMC/.test(s), "the rule as an artifact");
  ok(/\/Figure <<\/MCID \d+>> BDC\s[\s\S]*?Do\s*EMC/.test(s), "the picture as a figure");
});

await test("the parent tree maps each MCID back to its element; the link points at its annotation", () => {
  const page = doc.getPage(0);
  const rootDict = doc.catalog.lookup(PDFName.of("StructTreeRoot"));
  const nums = rootDict.lookup(PDFName.of("ParentTree")).lookup(PDFName.of("Nums")).asArray();
  const key = page.node.get(PDFName.of("StructParents")).asNumber();
  const at = nums.findIndex((x, i) => i % 2 === 0 && x.asNumber?.() === key);
  const arr = doc.context.lookup(nums[at + 1]);
  const s = Buffer.from(decodePDFRawStream(doc.context.lookup(page.node.get(PDFName.of("Contents")))).decode()).toString("latin1");
  eq(arr.size(), (s.match(/\/MCID /g) ?? []).length, "one entry per MCID");
  const annot = doc.context.lookup(page.node.Annots().get(0));
  const sp = annot.get(PDFName.of("StructParent")).asNumber();
  const elem = doc.context.lookup(nums[nums.findIndex((x, i) => i % 2 === 0 && x.asNumber?.() === sp) + 1]);
  eq(String(elem.get(PDFName.of("S"))), "/Link", "the annotation's element");
  eq(doc.context.lookup(elem.get(PDFName.of("K"))).get(PDFName.of("Obj")).toString(), page.node.Annots().get(0).toString(), "OBJR");
  eq(String(page.node.get(PDFName.of("Tabs"))), "/S", "tab order");
});

await test("an already tagged file keeps its tags", async () => {
  const [again] = await tagPdf(asFile(tagged), { title: "Other", lang: "fr" });
  eq(again.note, "tagKept", "note");
  const d = await PDFDocument.load(await bytesOf(again.blob));
  eq(d.catalog.lookup(PDFName.of("Lang")).decodeText(), "fr", "language set");
  eq(d.getTitle(), "Other", "title set");
});

await test("marks(): nested marked content and old MCIDs", () => {
  const b = new TextEncoder().encode("/P <</MCID 7>> BDC BT /F1 12 Tf 10 20 Td (x) Tj ET EMC 0 0 m 5 5 l S /Im1 Do");
  const { marks: m, mcidEdits } = marks(b, (n) => (n === "Im1" ? "image" : "other"));
  eq(m.map((x) => x.kind).join(" "), "text artifact figure", "kinds");
  eq(JSON.stringify(m[0].at), "[10,20]", "first glyph at the Td");
  eq(mcidEdits.length, 1, "the old MCID becomes a span");
});

await test("runs through runTool, with a language and title given", async () => {
  const [r] = await runTool("accessible", [asFile(src)], { accTitle: "Rapport annuel", accLang: "fr" });
  const d = await PDFDocument.load(await bytesOf(r.blob));
  eq(d.catalog.lookup(PDFName.of("Lang")).decodeText(), "fr", "Lang");
  eq(d.getTitle(), "Rapport annuel", "title");
});

if (process.env.VERAPDF) {
  const failing = (bytes) => {
    const file = join(mkdtempSync(join(tmpdir(), "pdfua-")), "in.pdf");
    writeFileSync(file, bytes);
    let report;
    try {
      report = execFileSync(process.env.VERAPDF, ["--flavour", "ua1", "--format", "text", "--verbose", file], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    } catch (e) {
      report = e.stdout?.toString() ?? "";
    }
    return [...new Set([...report.matchAll(/FAIL ([\d.]+-\d+)/g)].map((m) => m[1]))];
  };
  await test("veraPDF PDF/UA-1: fewer failures than untagged, none about structure or language", async () => {
    for (const name of ["fixture", "report.pdf", "scanned.pdf"]) {
      const bytes = name === "fixture" ? src : readFileSync(join(root, "tests/fixtures", name));
      const [t] = await tagPdf(asFile(bytes), { title: "", lang: "" });
      const before = failing(bytes), after = failing(await bytesOf(t.blob));
      ok(after.length < before.length, `${name}: before ${before}, after ${after}`);
      // Left: fonts the file doesn't embed (7.21.4.1) and figures without alt text (7.3).
      ok(after.every((r) => /^7\.21\.4\.1-|^7\.3-/.test(r)), `${name} left: ${after}`);
    }
  });
} else console.log("skip  veraPDF (set VERAPDF to check PDF/UA-1)");

console.log(results.failed ? `\n${results.failed} failed` : "\nall passed");
process.exit(results.failed ? 1 : 0);
