// Document structure tools (P2-09): metadata, bookmarks from headings,
// flatten, attachments, sanitize and web-optimize, checked with pdf.js,
// pdf-lib and qpdf.
//
//   node tests/structure.mjs
import { PDFDocument, PDFName, PDFString, PDFArray, StandardFonts } from "pdf-lib";
import { load, openPdf, check, eq } from "./lib/load.mjs";

globalThis.pdfjsWorker ??= await import("pdfjs-dist/legacy/build/pdf.worker.mjs");
const results = { failed: 0 };
const test = check(results);
const ok = (v, what) => {
  if (!v) throw new Error(what);
};
const st = await load("structure");
const { qpdfReport } = await load("qpdf");
const { runTool } = await load("run");
const asFile = (bytes, name = "in.pdf") => new File([bytes], name, { type: "application/pdf" });
const bytesOf = async (blob) => new Uint8Array(await blob.arrayBuffer());
const textOf = async (bytes) => {
  const doc = await openPdf(bytes.slice());
  const out = [];
  for (let i = 1; i <= doc.numPages; i++) out.push((await (await doc.getPage(i)).getTextContent()).items.map((t) => t.str).join(" "));
  return out.join(" | ");
};

// Two chapters with sections, in a larger and a bold face than the body.
async function report() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const body = "The quick brown fox jumps over the lazy dog again and again.";
  for (const [i, chapter] of ["Introduction", "Results"].entries()) {
    const page = doc.addPage([595, 842]);
    page.drawText(`${i + 1}. ${chapter}`, { x: 60, y: 760, size: 24, font: bold });
    for (let k = 0; k < 3; k++) page.drawText(body, { x: 60, y: 720 - k * 16, size: 11, font });
    page.drawText(`${i + 1}.1 Details of ${chapter.toLowerCase()}`, { x: 60, y: 640, size: 16, font: bold });
    for (let k = 0; k < 4; k++) page.drawText(body, { x: 60, y: 610 - k * 16, size: 11, font });
  }
  doc.setTitle("Old title");
  doc.setAuthor("Old Author");
  return doc.save();
}

await test("metadata: the title set reads back from pdf.js, in the properties and the XMP", async () => {
  const [out] = await st.editMetadata(asFile(await report()), { mode: "edit", title: "X", author: "", subject: "Quarterly", keywords: "alpha, beta" });
  const pdf = await openPdf(await bytesOf(out.blob));
  const { info, metadata } = await pdf.getMetadata();
  eq(info.Title, "X", "title");
  eq(info.Author, "Old Author", "a blank field keeps what was there");
  eq(info.Subject, "Quarterly", "subject");
  eq(info.Keywords, "alpha beta", "keywords");
  eq(metadata?.get("dc:title"), "X", "XMP title");
});

await test("metadata: clear removes every property and the XMP", async () => {
  const [out] = await st.editMetadata(asFile(await report()), { mode: "clear", title: "", author: "", subject: "", keywords: "" });
  const props = await st.readMetadata(out.blob);
  eq(JSON.stringify(props), "{}", "properties");
  const doc = await PDFDocument.load(await bytesOf(out.blob));
  eq(doc.catalog.has(PDFName.of("Metadata")), false, "no XMP");
});

await test("bookmarks: one per heading, sections nested under chapters, each on its page", async () => {
  const [out] = await st.bookmarks(asFile(await report()), { mode: "auto", depth: 3 });
  const pdf = await openPdf(await bytesOf(out.blob));
  const outline = await pdf.getOutline();
  eq(outline.map((o) => o.title).join(" / "), "1. Introduction / 2. Results", "chapters");
  eq(outline.map((o) => o.items.map((c) => c.title).join()).join(" / "), "1.1 Details of introduction / 2.1 Details of results", "sections");
  const page = async (o) => (await pdf.getPageIndex(o.dest[0])) + 1;
  eq(`${await page(outline[0])},${await page(outline[1])},${await page(outline[1].items[0])}`, "1,2,2", "pages");
  eq(out.note, "bookmarks:4", "note");
  const [flat] = await st.bookmarks(asFile(await report()), { mode: "auto", depth: 1 });
  eq((await (await openPdf(await bytesOf(flat.blob))).getOutline()).flatMap((o) => [o, ...o.items]).length, 2, "depth 1: chapters only");
  const [none] = await st.bookmarks(out.blob.size ? asFile(await bytesOf(out.blob)) : null, { mode: "remove", depth: 3 });
  eq(await (await openPdf(await bytesOf(none.blob))).getOutline(), null, "removed");
});

async function form() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([595, 842]);
  page.drawText("Name:", { x: 50, y: 760, size: 12, font });
  const f = doc.getForm();
  const name = f.createTextField("name");
  name.setText("Jane Applicant");
  name.addToPage(page, { x: 110, y: 750, width: 200, height: 24 });
  const agree = f.createCheckBox("agree");
  agree.check();
  agree.addToPage(page, { x: 110, y: 700, width: 16, height: 16 });
  const note = doc.context.register(doc.context.obj({ Type: "Annot", Subtype: "Text", Rect: [400, 700, 420, 720], Contents: PDFString.of("a sticky note") }));
  page.node.set(PDFName.of("Annots"), doc.context.obj([...page.node.lookup(PDFName.of("Annots"), PDFArray).asArray(), note]));
  return doc.save();
}

await test("flatten: no form fields left, and the values stay visible in the page text", async () => {
  const [out] = await st.flatten(asFile(await form()), { flattenWhat: "all" });
  const bytes = await bytesOf(out.blob);
  const doc = await PDFDocument.load(bytes);
  eq(doc.catalog.has(PDFName.of("AcroForm")), false, "no AcroForm");
  eq(doc.getForm().getFields().length, 0, "no fields");
  const pdf = await openPdf(bytes.slice());
  eq(await pdf.getFieldObjects(), null, "pdf.js finds no fields");
  ok((await textOf(bytes)).includes("Jane Applicant"), "the value is page text");
  // Annotations with an appearance are drawn in; a note without one (shown as an icon by readers) stays.
  eq((await (await pdf.getPage(1)).getAnnotations()).map((a) => a.subtype).join(), "Text", "only the note without an appearance stays");
  const [forms] = await st.flatten(asFile(await form()), { flattenWhat: "forms" });
  const kept = await (await (await openPdf(await bytesOf(forms.blob))).getPage(1)).getAnnotations();
  eq(kept.map((a) => a.subtype).join(), "Text", "forms only: the note stays");
});

await test("web-optimize: the output passes qpdf --check-linearization", async () => {
  const [out] = await st.linearize(asFile(await report()));
  const report2 = await qpdfReport(await bytesOf(out.blob), (i) => ["--check-linearization", i]);
  ok(/no linearization errors/.test(report2), report2);
  ok((await textOf(await bytesOf(out.blob))).includes("Introduction"), "same content");
});

await test("attachments: add, extract and remove", async () => {
  const csv = new File(["a,b\n1,2\n"], "figures.csv", { type: "text/csv" });
  const [withFile] = await st.attachments([asFile(await report(), "report.pdf"), csv], { attachMode: "add" });
  eq(withFile.name, "report-attached.pdf", "name");
  const found = await st.listAttachments(await bytesOf(withFile.blob));
  eq(found.map((f) => `${f.name}:${new TextDecoder().decode(f.data)}`).join(), "figures.csv:a,b\n1,2\n", "attached");
  const extracted = await st.attachments([asFile(await bytesOf(withFile.blob), "report.pdf")], { attachMode: "extract" });
  eq(extracted.map((o) => o.name).join(), "figures.csv", "extracted");
  eq(await extracted[0].blob.text(), "a,b\n1,2\n", "extracted bytes");
  const [clean] = await st.attachments([asFile(await bytesOf(withFile.blob), "report.pdf")], { attachMode: "remove" });
  eq((await st.listAttachments(await bytesOf(clean.blob))).length, 0, "removed");
  let err = null;
  await st.attachments([asFile(await report(), "plain.pdf")], { attachMode: "extract" }).catch((e) => (err = e));
  eq(err?.code, "no_attachments", "nothing to extract says so");
});

await test("sanitize: scripts, links, attachments and metadata are gone; the text stays", async () => {
  const doc = await PDFDocument.load(await report());
  doc.catalog.set(PDFName.of("OpenAction"), doc.context.obj({ S: "JavaScript", JS: PDFString.of("app.alert('hi')") }));
  const page = doc.getPage(0);
  const link = doc.context.register(doc.context.obj({ Type: "Annot", Subtype: "Link", Rect: [60, 760, 200, 780], A: { S: "URI", URI: PDFString.of("https://tracker.example/x") } }));
  page.node.set(PDFName.of("Annots"), doc.context.obj([link]));
  await doc.attach(new TextEncoder().encode("secret"), "hidden.txt", { mimeType: "text/plain" });
  const [out] = await st.sanitize(asFile(await doc.save()), { scripts: true, files: true, links: true, metadata: true, forms: false });
  const bytes = await bytesOf(out.blob);
  const raw = Buffer.from(bytes).toString("latin1");
  ok(!/JavaScript|app\.alert/.test(raw), "script");
  ok(!/tracker\.example/.test(raw), "link");
  eq((await st.listAttachments(bytes)).length, 0, "attachment");
  eq(JSON.stringify(await st.readMetadata(out.blob)), "{}", "properties");
  ok((await textOf(bytes)).includes("Introduction"), "text kept");
  eq(out.note, "sanitized:scripts,links,files,metadata", "what was removed");
});

await test("the tools run through runTool as a workflow step does", async () => {
  const [a] = await runTool("metadata", [asFile(await report())], { metaMode: "edit", metaTitle: "Y" });
  eq((await (await openPdf(await bytesOf(a.blob))).getMetadata()).info.Title, "Y", "metadata step");
  const [b] = await runTool("linearize", [asFile(await report())], {});
  ok(b.blob.size > 0, "linearize step");
});

console.log(results.failed ? `\n${results.failed} failed` : "\nall passed");
process.exit(results.failed ? 1 : 0);
