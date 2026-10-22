// Print and scan helpers (P2-10): N-up, booklet order, blank pages, alternate
// and mix, resize, greyscale and header/footer, checked with pdf.js and pdf-lib.
//
//   node tests/impose.mjs
import { PDFDocument, PDFName, PDFArray, PDFHexString, PDFRawStream, StandardFonts, rgb, cmyk, decodePDFRawStream } from "pdf-lib";
import { load, openPdf, check, eq, nodeCanvas } from "./lib/load.mjs";

globalThis.pdfjsWorker ??= await import("pdfjs-dist/legacy/build/pdf.worker.mjs");
nodeCanvas();
const results = { failed: 0 };
const test = check(results);
const ok = (v, what) => {
  if (!v) throw new Error(what);
};
const im = await load("impose");
const { grayscale } = await load("gray");
const { tokens } = await load("content");
const { runTool } = await load("run");
const asFile = (bytes, name = "in.pdf") => new File([bytes], name, { type: "application/pdf" });
const bytesOf = async (blob) => new Uint8Array(await blob.arrayBuffer());
const pagesText = async (bytes) => {
  const doc = await openPdf(bytes.slice());
  const out = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const items = (await (await doc.getPage(i)).getTextContent()).items.filter((t) => t.str.trim());
    // Left to right, then top to bottom.
    items.sort((a, b) => Math.round(b.transform[5] / 50) - Math.round(a.transform[5] / 50) || a.transform[4] - b.transform[4]);
    out.push(items.map((t) => t.str).join(" "));
  }
  return out;
};

// Pages labelled P1…Pn (or "label" for each), A4 portrait.
async function labelled(n, label = (i) => `P${i}`, size = [595, 842]) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= n; i++) {
    const page = doc.addPage(size);
    const text = label(i);
    if (text) page.drawText(text, { x: 200, y: 420, size: 40, font });
  }
  return doc.save();
}

await test("booklet order: 8 pages are two sheets, [8,1] [2,7] and [6,3] [4,5]", async () => {
  eq(JSON.stringify(im.bookletOrder(8)), JSON.stringify([[8, 1], [2, 7], [6, 3], [4, 5]]), "order");
  const [out] = await im.booklet(asFile(await labelled(8)), { paper: "same", binding: "left" });
  const texts = await pagesText(await bytesOf(out.blob));
  eq(JSON.stringify(texts), JSON.stringify(["P8 P1", "P2 P7", "P6 P3", "P4 P5"]), "sides");
  const doc = await PDFDocument.load(await bytesOf(out.blob));
  const { width, height } = doc.getPage(0).getSize();
  ok(width > height && Math.abs(width - 842) < 1, `landscape sheet ${width}×${height}`);
});

await test("booklet: 6 pages are padded with blanks; right binding reads the other way", async () => {
  const [out] = await im.booklet(asFile(await labelled(6)), { paper: "a4", binding: "right" });
  const texts = await pagesText(await bytesOf(out.blob));
  eq(JSON.stringify(texts), JSON.stringify(["P1", "P2", "P3 P6", "P5 P4"]), "sides");
});

await test("N-up: 4 per sheet, left to right and top to bottom; 2 per sheet on a landscape sheet", async () => {
  const [four] = await im.nUp(asFile(await labelled(6)), { per: 4, paper: "same", frame: true });
  eq(JSON.stringify(await pagesText(await bytesOf(four.blob))), JSON.stringify(["P1 P2 P3 P4", "P5 P6"]), "4-up");
  const [two] = await im.nUp(asFile(await labelled(3)), { per: 2, paper: "a4" });
  const doc = await PDFDocument.load(await bytesOf(two.blob));
  eq(doc.getPageCount(), 2, "sheets");
  const { width, height } = doc.getPage(0).getSize();
  ok(width > height, "landscape");
  const [nine] = await im.nUp(asFile(await labelled(9)), { per: 9, paper: "letter" });
  eq((await pagesText(await bytesOf(nine.blob)))[0], "P1 P2 P3 P4 P5 P6 P7 P8 P9", "9-up");
});

await test("N-up keeps a rotated page upright", async () => {
  const src = await PDFDocument.load(await labelled(2));
  src.getPage(1).setRotation({ type: "degrees", angle: 90 });
  const [out] = await im.nUp(asFile(await src.save()), { per: 2, paper: "same" });
  const pdf = await openPdf(await bytesOf(out.blob));
  const items = (await (await pdf.getPage(1)).getTextContent()).items.filter((t) => t.str === "P2");
  const [a, b] = items[0].transform;
  // Shown turned a quarter: the text runs downwards on the sheet, as it did on the page.
  ok(Math.abs(a) < 0.01 && b < 0, `transform ${items[0].transform}`);
});

await test("remove blank pages: exactly the two blank ones go, a page with one short word stays", async () => {
  const label = (i) => (i === 2 || i === 5 ? "" : i === 4 ? "ok" : `Page ${i} has text`);
  const doc = await PDFDocument.load(await labelled(6, label));
  // A page number in the bottom margin doesn't make a page "not blank".
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.getPage(4).drawText("5", { x: 290, y: 20, size: 10, font });
  const [out] = await im.removeBlank(asFile(await doc.save()), { level: "normal" });
  eq(out.note, "blankRemoved:2", "note");
  eq(JSON.stringify(await pagesText(await bytesOf(out.blob))), JSON.stringify(["Page 1 has text", "Page 3 has text", "ok", "Page 6 has text"]), "pages kept");
});

await test("remove blank pages: none blank gives the file back; all blank is an error", async () => {
  const [same] = await im.removeBlank(asFile(await labelled(2)), { level: "strict" });
  eq(same.note, "blankNone", "note");
  let code;
  await im.removeBlank(asFile(await labelled(2, () => "")), { level: "normal" }).catch((e) => (code = e.code));
  eq(code, "all_blank", "error");
});

await test("alternate and mix: fronts and reversed backs interleave", async () => {
  const fronts = asFile(await labelled(3, (i) => `F${i}`), "fronts.pdf");
  const backs = asFile(await labelled(3, (i) => `B${4 - i}`), "backs.pdf");
  const [out] = await im.mix([fronts, backs], { reverse: true });
  eq(JSON.stringify(await pagesText(await bytesOf(out.blob))), JSON.stringify(["F1", "B1", "F2", "B2", "F3", "B3"]), "order");
  const [plain] = await im.mix([asFile(await labelled(3, (i) => `A${i}`)), asFile(await labelled(1, () => "Z"))], { reverse: false });
  eq(JSON.stringify(await pagesText(await bytesOf(plain.blob))), JSON.stringify(["A1", "Z", "A2", "A3"]), "uneven");
});

await test("resize: a Letter page becomes A4 with its text and its link moved along", async () => {
  const doc = await PDFDocument.load(await labelled(1, () => "Hello", [612, 792]));
  const page = doc.getPage(0);
  const link = doc.context.register(doc.context.obj({ Type: "Annot", Subtype: "Link", Rect: [0, 0, 612, 792], A: { S: "URI", URI: "https://example.com" } }));
  page.node.set(PDFName.of("Annots"), doc.context.obj([link]));
  const landscape = doc.addPage([792, 612]);
  void landscape;
  const [out] = await im.resize(asFile(await doc.save()), { paper: "a4" });
  const res = await PDFDocument.load(await bytesOf(out.blob));
  const [p1, p2] = res.getPages();
  eq(p1.getSize().width.toFixed(1) + "x" + p1.getSize().height.toFixed(1), "595.3x841.9", "A4 portrait");
  eq(p2.getSize().width.toFixed(1) + "x" + p2.getSize().height.toFixed(1), "841.9x595.3", "A4 landscape");
  const rect = res.context.lookup(p1.node.Annots().get(0)).lookup(PDFName.of("Rect")).asArray().map((x) => Math.round(x.asNumber()));
  // Scaled by 595.28/612 and centred vertically.
  eq(JSON.stringify(rect), JSON.stringify([0, 36, 595, 806]), "link rect");
  eq((await pagesText(await bytesOf(out.blob)))[0], "Hello", "text");
});

// Every content stream's colour operators, and every image's colour space.
async function colourUse(bytes) {
  const doc = await PDFDocument.load(bytes);
  const ops = [];
  const spaces = [];
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream)) continue;
    const sub = String(obj.dict.get(PDFName.of("Subtype")));
    if (sub === "/Image") { spaces.push(String(obj.dict.get(PDFName.of("ColorSpace")))); continue; }
    if (sub !== "/Form" && obj.dict.has(PDFName.of("Type")) && !obj.dict.has(PDFName.of("BBox"))) continue;
    let b;
    try { b = decodePDFRawStream(obj).decode(); } catch { continue; }
    let nums = 0;
    for (const t of tokens(b)) {
      if ("num" in t) { nums++; continue; }
      if ("op" in t) {
        if (["rg", "RG", "k", "K"].includes(t.op) || (["sc", "scn", "SC", "SCN"].includes(t.op) && nums > 1)) ops.push(t.op);
      }
      if ("inline" in t) spaces.push(String(t.inline.CS ?? t.inline.ColorSpace));
      if (!("num" in t)) nums = "name" in t ? nums : 0;
    }
  }
  return { ops, spaces };
}

await test("greyscale: no RGB or CMYK image and no colour operator left; the text stays", async () => {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([400, 400]);
  page.drawText("Red text", { x: 40, y: 340, size: 20, font, color: rgb(1, 0, 0) });
  page.drawRectangle({ x: 40, y: 200, width: 100, height: 100, color: cmyk(0, 1, 1, 0), borderColor: rgb(0, 0, 1), borderWidth: 3 });
  // An RGB picture, Flate-compressed, 64×64.
  const w = 64, h = 64, px = Buffer.alloc(w * h * 3);
  for (let i = 0; i < w * h; i++) { px[i * 3] = (i * 7) % 256; px[i * 3 + 1] = 128; px[i * 3 + 2] = 255 - (i % 256); }
  const img = doc.context.register(doc.context.flateStream(px, { Type: "XObject", Subtype: "Image", Width: w, Height: h, ColorSpace: "DeviceRGB", BitsPerComponent: 8 }));
  // A palette over RGB, an ICC-less CalRGB-free sc colour, an axial shading and a form.
  const shading = doc.context.obj({ ShadingType: 2, ColorSpace: "DeviceRGB", Coords: [0, 0, 100, 0], Function: { FunctionType: 2, Domain: [0, 1], C0: [1, 0, 0], C1: [0, 0, 1], N: 1 } });
  const form = doc.context.register(doc.context.stream("0 1 0 rg 0 0 20 20 re f", { Type: "XObject", Subtype: "Form", BBox: [0, 0, 20, 20], Resources: {} }));
  const res = page.node.Resources();
  res.set(PDFName.of("XObject"), doc.context.obj({ Im9: img, Fm9: form }));
  res.set(PDFName.of("Shading"), doc.context.obj({ Sh9: shading }));
  res.set(PDFName.of("ColorSpace"), doc.context.obj({ CS9: "DeviceRGB", CS8: ["Indexed", "DeviceRGB", 1, PDFHexString.of("ff000000ff00")] }));
  const extra = "q /CS9 cs 0.2 0.4 0.6 sc 200 200 50 50 re f Q q /CS9 CS 1 1 0 SC 200 100 m 300 100 l S Q q 150 0 0 150 220 20 cm /Im9 Do Q q 200 300 cm /Fm9 Do Q q 0 0 100 50 re W n /Sh9 sh Q " +
    "q /CS8 cs 1 sc 10 10 20 20 re f Q q 10 0 0 10 350 350 cm BI /W 2 /H 1 /BPC 8 /CS /RGB ID \xff\x00\x00\x00\xff\x00 EI Q";
  page.node.addContentStream(doc.context.register(doc.context.stream(Buffer.from(extra, "latin1"))));
  const before = await colourUse(await doc.save());
  ok(before.ops.length >= 4 && before.spaces.includes("/DeviceRGB"), `fixture: ${JSON.stringify(before)}`);
  const [out] = await grayscale(asFile(await doc.save()));
  const bytes = await bytesOf(out.blob);
  const after = await colourUse(bytes);
  ok(!after.ops.some((op) => ["rg", "RG", "k", "K", "sc", "scn", "SC", "SCN"].includes(op)), `colour operators left: ${after.ops}`);
  ok(!after.spaces.some((s) => /RGB|CMYK/.test(s)), `colour images left: ${after.spaces}`);
  const res2 = (await PDFDocument.load(bytes)).getPage(0).node.Resources();
  const sh = res2.lookup(PDFName.of("Shading")).lookup(PDFName.of("Sh9"));
  eq(String(sh.get(PDFName.of("ColorSpace"))), "/DeviceGray", "shading space");
  const pal = res2.lookup(PDFName.of("ColorSpace")).lookup(PDFName.of("CS8"));
  eq(String(pal.get(1)), "/DeviceGray", "palette base");
  eq(out.note, undefined, "nothing left over");
  eq((await pagesText(bytes))[0], "Red text", "text");
});

await test("greyscale: red text becomes the grey of its lightness", async () => {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage([200, 200]).drawText("x", { x: 10, y: 10, size: 20, font, color: rgb(1, 0, 0) });
  const [out] = await grayscale(asFile(await doc.save()));
  const d = await PDFDocument.load(await bytesOf(out.blob));
  const content = d.getPage(0).node.Contents();
  const s = Buffer.from(decodePDFRawStream(content instanceof PDFArray ? d.context.lookup(content.get(0)) : d.context.lookup(d.getPage(0).node.get(PDFName.of("Contents")))).decode()).toString("latin1");
  ok(/0\.299 g/.test(s), s.slice(0, 200));
});

await test("header and footer: filled in on the chosen pages", async () => {
  const [out] = await runTool("headerFooter", [asFile(await labelled(3), "minutes.pdf")], { hfHeader: "{filename}", hfFooter: "{page} / {pages}", hfAlign: "right", pageRange: "", hfSkipFirst: 1, fontSize: 10, color: "#000000" });
  const texts = await pagesText(await bytesOf(out.blob));
  eq(texts[0], "P1", "first page skipped");
  ok(/minutes/.test(texts[1]) && /2 \/ 3/.test(texts[1]) && /3 \/ 3/.test(texts[2]), JSON.stringify(texts));
});

await test("the tools run through runTool as a workflow step does", async () => {
  const src = asFile(await labelled(4));
  for (const [id, o] of [["nUp", { nupPages: "4", sheetSize: "same" }], ["booklet", { sheetSize: "a4", binding: "left" }], ["resize", { pageSize: "letter" }], ["grayscale", {}], ["removeBlank", { blankLevel: "normal" }]]) {
    const [out] = await runTool(id, [src], o);
    ok(out.blob.size > 300, `${id}: ${out.blob.size} bytes`);
  }
  const [mixed] = await runTool("mix", [src, asFile(await labelled(1, () => "Z"))], { mixReverse: false });
  eq((await PDFDocument.load(await bytesOf(mixed.blob))).getPageCount(), 5, "mix");
});

console.log(results.failed ? `\n${results.failed} failed` : "\nall passed");
process.exit(results.failed ? 1 : 0);
