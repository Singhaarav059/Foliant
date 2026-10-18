// Page-subset tests: split, extract, remove and organize must carry only the
// pages they output. A link's destination names another page, and copying a
// page by following everything it refers to brought every linked page along
// as hidden content (a one-page part of a linked book held the whole book).
//
//   node tests/organize.mjs
import {
  PDFDocument, PDFName, PDFString, PDFHexString, PDFNumber, PDFRawStream, PDFArray, PDFDict, PDFRef, PDFNull, StandardFonts, decodePDFRawStream,
  pushGraphicsState, popGraphicsState, concatTransformationMatrix, drawObject,
} from "pdf-lib";
import { load, openPdf, check, eq } from "./lib/load.mjs";
import { corpus } from "./lib/corpus.mjs";

const { split, buildFromPlan, extractSeparate, merge, rotateAll } = await load("organize");
const results = { failed: 0 };
const test = check(results);
const CHAPTERS = 60;

// A 61-page book: a contents page linking to 60 chapters, each with its own
// photo-like image and a secret line, and a "back to contents" link. Half of
// the contents links use /Dest, half a GoTo action. Each chapter also has a
// "next" button (a GoTo that isn't a link), a form field whose parent is
// shared by every chapter's field, as in forms exported from layout tools,
// and a note, with its pop-up, that replies to the previous chapter's note.
async function book() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const contents = doc.addPage([400, 600]);
  contents.drawText("Contents", { x: 40, y: 560, size: 18, font });
  let seed = 11;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) >> 16) & 0xff;
  const form = doc.context.register(doc.context.obj({ T: PDFString.of("applicant"), Kids: [] }));
  const pages = [contents, ...Array.from({ length: CHAPTERS }, () => doc.addPage([400, 600]))];
  let note;
  for (let n = 1; n <= CHAPTERS; n++) {
    const page = pages[n];
    page.drawText(`Chapter ${n}`, { x: 40, y: 560, size: 18, font });
    page.drawText(`SECRET-CHAPTER-${n}`, { x: 40, y: 530, size: 12, font });
    // 64×64 noise doesn't compress: about 12 KB per chapter.
    const px = Uint8Array.from({ length: 64 * 64 * 3 }, rnd);
    const img = doc.context.register(doc.context.flateStream(px, { Type: "XObject", Subtype: "Image", Width: 64, Height: 64, ColorSpace: "DeviceRGB", BitsPerComponent: 8 }));
    page.node.setXObject(PDFName.of("Im1"), img);
    page.pushOperators(pushGraphicsState(), concatTransformationMatrix(200, 0, 0, 200, 100, 200), drawObject("Im1"), popGraphicsState());
    const back = doc.context.register(doc.context.obj({ Type: "Annot", Subtype: "Link", Rect: [40, 20, 200, 40], Border: [0, 0, 0], Dest: [contents.ref, PDFName.of("Fit")] }));
    const next = doc.context.register(doc.context.obj({
      Type: "Annot", Subtype: "Widget", FT: PDFName.of("Btn"), Ff: 65536, T: PDFString.of(`next${n}`), Rect: [220, 20, 300, 40], P: page.ref,
      A: { S: "GoTo", D: [pages[(n + 1) % pages.length].ref, PDFName.of("Fit")] },
    }));
    const field = doc.context.register(doc.context.obj({ FT: PDFName.of("Tx"), T: PDFString.of(`answer${n}`), V: PDFString.of(`SECRET-FIELD-${n}`), Parent: form, Kids: [] }));
    const widget = doc.context.register(doc.context.obj({ Type: "Annot", Subtype: "Widget", Rect: [40, 480, 300, 500], P: page.ref, Parent: field }));
    doc.context.lookup(field, PDFDict).lookup(PDFName.of("Kids"), PDFArray).push(widget);
    doc.context.lookup(form, PDFDict).lookup(PDFName.of("Kids"), PDFArray).push(field);
    const reply = doc.context.register(doc.context.obj({ Type: "Annot", Subtype: "Text", Rect: [320, 560, 340, 580], P: page.ref, Contents: PDFString.of(`SECRET-NOTE-${n}`), ...(note ? { IRT: note } : {}) }));
    const popup = doc.context.register(doc.context.obj({ Type: "Annot", Subtype: "Popup", Rect: [340, 480, 400, 560], P: page.ref, Parent: reply }));
    doc.context.lookup(reply, PDFDict).set(PDFName.of("Popup"), popup);
    note = reply;
    page.node.set(PDFName.of("Annots"), doc.context.obj([back, next, widget, reply, popup]));
  }
  const links = [];
  for (let n = 1; n <= CHAPTERS; n++) {
    const target = doc.getPage(n).ref;
    const y = 540 - n * 8;
    const dest = [target, PDFName.of("XYZ"), null, null, null];
    links.push(doc.context.register(doc.context.obj(n % 2
      ? { Type: "Annot", Subtype: "Link", Rect: [40, y, 200, y + 7], Border: [0, 0, 0], Dest: dest }
      : { Type: "Annot", Subtype: "Link", Rect: [40, y, 200, y + 7], Border: [0, 0, 0], A: { S: "GoTo", D: dest } })));
  }
  contents.node.set(PDFName.of("Annots"), doc.context.obj(links));
  return doc.save();
}

const input = await book();
const file = (bytes = input, name = "book.pdf") => new File([bytes], name, { type: "application/pdf" });
const open = async (blob) => {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return { bytes, doc: await PDFDocument.load(bytes) };
};

// Every object in the file, reachable or not, as text: decoded streams plus
// literal and hex strings, so a secret in any form shows up.
function everything(doc) {
  const parts = [];
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (obj instanceof PDFRawStream) {
      let data;
      try {
        data = decodePDFRawStream(obj).decode();
      } catch {
        data = obj.contents;
      }
      parts.push(obj.dict.toString(), Buffer.from(data).toString("latin1"));
    } else parts.push(obj.toString());
  }
  const raw = parts.join("\n");
  // Hex strings (as pdf-lib writes text) decoded too.
  return raw + raw.replace(/<([0-9A-Fa-f\s]+)>/g, (_, h) => Buffer.from(h.replace(/\s/g, ""), "hex").toString("latin1"));
}
const images = (doc) => doc.context.enumerateIndirectObjects().filter(([, o]) => o instanceof PDFRawStream && o.dict.get(PDFName.of("Subtype")) === PDFName.of("Image")).length;
const pageObjects = (doc) => doc.context.enumerateIndirectObjects().filter(([, o]) => o instanceof PDFDict && o.get(PDFName.of("Type")) === PDFName.of("Page")).length;
const secrets = (doc, kind = "CHAPTER") => [...new Set(everything(doc).match(new RegExp(`SECRET-${kind}-\\d+`, "g")) ?? [])].sort();
const linkTargets = (doc, i) => {
  const annots = doc.getPage(i).node.lookupMaybe(PDFName.of("Annots"), PDFArray)?.asArray() ?? [];
  return annots.map((r) => doc.context.lookup(r, PDFDict)).filter((a) => a.get(PDFName.of("Subtype")) === PDFName.of("Link")).map((a) => {
    const d = a.lookupMaybe(PDFName.of("Dest"), PDFArray) ?? a.lookupMaybe(PDFName.of("A"), PDFDict)?.lookupMaybe(PDFName.of("D"), PDFArray);
    const target = d?.get(0);
    return target instanceof PDFRef ? doc.getPages().findIndex((p) => p.ref === target) : target === PDFNull ? "null" : String(target);
  });
};

await test("the book really links every page (else this test proves nothing)", async () => {
  const doc = await PDFDocument.load(input);
  eq(doc.getPageCount(), 61, "pages");
  eq(images(doc), CHAPTERS, "images");
  eq(linkTargets(doc, 0).length, CHAPTERS, "contents links");
});

await test("split every page: each part holds only its own page", async () => {
  const parts = await split(file(), { splitMode: "every", every: 1, ranges: "", maxMb: 1, mergeRanges: false });
  eq(parts.length, 61, "parts");
  const sizes = [];
  for (let i = 0; i < parts.length; i++) {
    const { bytes, doc } = await open(parts[i].blob);
    sizes.push(bytes.length);
    if (bytes.length >= 40 * 1024) throw new Error(`part ${i + 1} is ${Math.round(bytes.length / 1024)} KB`);
    eq(doc.getPageCount(), 1, `part ${i + 1} pages`);
    eq(pageObjects(doc), 1, `part ${i + 1} page objects`);
    eq(images(doc), i ? 1 : 0, `part ${i + 1} images`);
    eq(secrets(doc).join(), i ? `SECRET-CHAPTER-${i}` : "", `part ${i + 1} secrets`);
    eq(secrets(doc, "FIELD").join(), i ? `SECRET-FIELD-${i}` : "", `part ${i + 1} form values`);
    eq(secrets(doc, "NOTE").join(), i ? `SECRET-NOTE-${i}` : "", `part ${i + 1} notes`);
  }
  return `largest ${Math.round(Math.max(...sizes) / 1024)} KB`;
});

await test("organize keeping only the contents page stores no chapter", async () => {
  const { doc } = await open(await buildFromPlan([file()], [{ file: 0, page: 0, rotate: 0 }]));
  eq(doc.getPageCount(), 1, "pages");
  eq(images(doc), 0, "images");
  eq(secrets(doc).length, 0, "chapter secrets");
  eq(secrets(doc, "FIELD").length, 0, "form values");
  // Links to pages that aren't in the file are dropped, not left pointing nowhere.
  eq(linkTargets(doc, 0).length, 0, "links");
});

await test("remove pages: the removed chapters are gone, links between kept pages still work", async () => {
  const plan = Array.from({ length: 61 }, (_, i) => ({ file: 0, page: i, rotate: 0 })).filter((p) => p.page < 11 || p.page > 20);
  const { doc } = await open(await buildFromPlan([file()], plan));
  eq(doc.getPageCount(), 51, "pages");
  eq(pageObjects(doc), 51, "page objects");
  eq(images(doc), 50, "images");
  const left = secrets(doc);
  for (let n = 11; n <= 20; n++) if (left.includes(`SECRET-CHAPTER-${n}`)) throw new Error(`chapter ${n} still inside`);
  // Contents links now go to the right pages of the new file: chapter n is page n (n ≤ 10) or n − 10.
  const targets = linkTargets(doc, 0);
  eq(targets.length, 50, "contents links");
  eq(targets.join(), [...Array.from({ length: 10 }, (_, i) => i + 1), ...Array.from({ length: 40 }, (_, i) => i + 11)].join(), "contents link targets");
  eq(linkTargets(doc, 30).join(), "0", "back link of a chapter");
});

await test("extract separately and as one file", async () => {
  const parts = await extractSeparate(file(), [5, 40]);
  for (const [i, n] of [[0, 5], [1, 40]]) {
    const { doc } = await open(parts[i].blob);
    eq(images(doc), 1, `page ${n} images`);
    eq(secrets(doc).join(), `SECRET-CHAPTER-${n}`, `page ${n} secrets`);
  }
  const { doc } = await open(await buildFromPlan([file()], [{ file: 0, page: 5, rotate: 0 }, { file: 0, page: 40, rotate: 90 }]));
  eq(images(doc), 2, "images");
  eq(secrets(doc).join(), "SECRET-CHAPTER-40,SECRET-CHAPTER-5", "secrets");
  eq(doc.getPage(1).getRotation().angle, 90, "rotation");
});

await test("split by ranges, merged into one file", async () => {
  const [part] = await split(file(), { splitMode: "ranges", every: 1, ranges: "2-3, 60", maxMb: 1, mergeRanges: true });
  const { doc } = await open(part.blob);
  eq(doc.getPageCount(), 3, "pages");
  eq(secrets(doc).join(), "SECRET-CHAPTER-1,SECRET-CHAPTER-2,SECRET-CHAPTER-59", "secrets");
});

await test("split by size counts only the pages in each part", async () => {
  // 61 pages of ~12 KB: about 7 parts of 100 KB, not 61 parts of a whole book each.
  const parts = await split(file(), { splitMode: "size", every: 1, ranges: "", maxMb: 0.1, mergeRanges: false });
  if (parts.length > 12) throw new Error(`${parts.length} parts`);
  let pages = 0;
  for (const p of parts) pages += (await open(p.blob)).doc.getPageCount();
  eq(pages, 61, "pages over all parts");
  return `${parts.length} parts`;
});

// Pages that share one /Resources dictionary naming every page's image (as
// some producers write them): a part must store only the images and fonts
// its own pages draw.
async function sharedResources() {
  const doc = await PDFDocument.create();
  const ctx = doc.context;
  const font = await doc.embedFont(StandardFonts.Helvetica);
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) >> 16) & 0xff;
  const xobjects = {};
  for (let n = 1; n <= 10; n++) {
    xobjects[`Im${n}`] = ctx.register(ctx.flateStream(Uint8Array.from({ length: 32 * 32 * 3 }, rnd), { Type: "XObject", Subtype: "Image", Width: 32, Height: 32, ColorSpace: "DeviceRGB", BitsPerComponent: 8 }));
  }
  const unused = await doc.embedFont(StandardFonts.Courier);
  const resources = ctx.register(ctx.obj({ XObject: xobjects, Font: { F1: font.ref, F2: unused.ref }, ProcSet: [PDFName.of("PDF"), PDFName.of("ImageC")] }));
  for (let n = 1; n <= 10; n++) {
    const page = doc.addPage([300, 300]);
    page.node.set(PDFName.of("Resources"), resources);
    page.node.set(PDFName.of("Contents"), ctx.register(ctx.stream(`q 100 0 0 100 50 50 cm /Im${n} Do Q BT /F1 12 Tf 20 260 Td (SHARED${n}) Tj ET`)));
  }
  return doc.save();
}
await test("parts of pages that share their resources store only what they draw", async () => {
  const bytes = await sharedResources();
  const shared = (name = "shared.pdf") => file(bytes, name);
  const parts = await split(shared(), { splitMode: "every", every: 1, ranges: "", maxMb: 1, mergeRanges: false });
  eq(parts.length, 10, "parts");
  const fonts = (doc) => doc.context.enumerateIndirectObjects().filter(([, o]) => o instanceof PDFDict && o.get(PDFName.of("Type")) === PDFName.of("Font") && !o.has(PDFName.of("DescendantFonts")) && !o.has(PDFName.of("FontName"))).length;
  for (let i = 0; i < parts.length; i++) {
    const { bytes: b, doc } = await open(parts[i].blob);
    eq(images(doc), 1, `part ${i + 1} images`);
    eq(fonts(doc), 1, `part ${i + 1} fonts`);
    const pdf = await openPdf(b);
    eq((await (await pdf.getPage(1)).getTextContent()).items.map((t) => t.str).join(""), `SHARED${i + 1}`, `part ${i + 1} text`);
    await pdf.loadingTask.destroy();
  }
  eq(images((await open((await extractSeparate(shared(), [4]))[0].blob)).doc), 1, "extracted page images");
  eq(images((await open(await buildFromPlan([shared()], [{ file: 0, page: 2, rotate: 0 }, { file: 0, page: 7, rotate: 0 }]))).doc), 2, "organized pages images");
  // Two pages from one file in one part still share one copy of what both draw.
  const { doc } = await open(await buildFromPlan([shared()], [{ file: 0, page: 2, rotate: 0 }, { file: 0, page: 2, rotate: 90 }]));
  eq(images(doc), 1, "a duplicated page's image stored once");
});

// /T is optional, so a parent field can be a bare { Kids }. Each page also
// has a reset button naming that parent, so it's reached before its widgets.
// Some files leave out the fields' /Parent, and the form's field tree still
// lists the parent; broken ones list nothing either.
for (const shape of ["", " (no /Parent)", " (no /Parent, no field list)"]) await test(`a form whose top field has no name still splits page by page${shape}`, async () => {
  const doc = await PDFDocument.create();
  const parent = doc.context.register(doc.context.obj({ Kids: [] }));
  const linked = !shape;
  if (shape === " (no /Parent)") doc.catalog.set(PDFName.of("AcroForm"), doc.context.obj({ Fields: [parent] }));
  for (let i = 0; i < 3; i++) {
    const page = doc.addPage([200, 200]);
    const field = doc.context.register(doc.context.obj({ FT: PDFName.of("Tx"), T: PDFString.of(`f${i}`), V: PDFString.of(`SECRET-FIELD-${i}`), ...(linked ? { Parent: parent } : {}), Kids: [] }));
    const widget = doc.context.register(doc.context.obj({ Type: "Annot", Subtype: "Widget", Rect: [0, 0, 50, 20], P: page.ref, Parent: field }));
    const reset = doc.context.register(doc.context.obj({
      Type: "Annot", Subtype: "Widget", FT: PDFName.of("Btn"), Ff: 65536, T: PDFString.of(`reset${i}`), Rect: [60, 0, 100, 20], P: page.ref,
      A: { S: "ResetForm", Fields: [parent] },
    }));
    doc.context.lookup(field, PDFDict).lookup(PDFName.of("Kids"), PDFArray).push(widget);
    doc.context.lookup(parent, PDFDict).lookup(PDFName.of("Kids"), PDFArray).push(field);
    page.node.set(PDFName.of("Annots"), doc.context.obj([reset, widget]));
  }
  const parts = await split(file(await doc.save(), "form.pdf"), { splitMode: "every", every: 1, ranges: "", maxMb: 1, mergeRanges: false });
  eq(parts.length, 3, "parts");
  for (let i = 0; i < 3; i++) eq(secrets((await open(parts[i].blob)).doc, "FIELD").join(), `SECRET-FIELD-${i}`, `part ${i + 1} form values`);
});

await test("a duplicated page is a page of its own", async () => {
  const { doc } = await open(await buildFromPlan([file()], [{ file: 0, page: 3, rotate: 0 }, { file: 0, page: 3, rotate: 180 }]));
  eq(doc.getPageCount(), 2, "pages");
  eq(doc.getPage(0).ref === doc.getPage(1).ref, false, "distinct page objects");
  eq(doc.getPage(0).getRotation().angle, 0, "first rotation");
  eq(doc.getPage(1).getRotation().angle, 180, "second rotation");
  eq(images(doc), 1, "the shared image is stored once");
  // Each copy has annotations of its own, on it: a shared one would be
  // edited or deleted on both pages at once. A note and its pop-up stay a pair.
  const annots = [0, 1].map((i) => doc.getPage(i).node.lookup(PDFName.of("Annots"), PDFArray).asArray());
  eq(annots.map((a) => a.length).join(), "4,4", "annotations");
  eq(annots[0].some((r) => annots[1].includes(r)), false, "annotations shared by both pages");
  const get = (ref, key) => doc.context.lookup(ref, PDFDict).get(PDFName.of(key));
  for (const i of [0, 1]) {
    eq(annots[i].every((r) => get(r, "P") === doc.getPage(i).ref), true, `page ${i + 1} annotations on their page`);
    const reply = annots[i].find((r) => get(r, "Subtype") === PDFName.of("Text"));
    eq(annots[i].includes(get(reply, "Popup")) && get(get(reply, "Popup"), "Parent") === reply, true, `page ${i + 1} note and pop-up`);
  }
});

await test("merge keeps each file's links inside that file", async () => {
  const [out] = await merge([file(), file(input, "copy.pdf")], { bookmarks: false });
  const { doc } = await open(out.blob);
  eq(doc.getPageCount(), 122, "pages");
  eq(pageObjects(doc), 122, "page objects");
  eq(images(doc), 120, "images");
  eq(linkTargets(doc, 61).join(), Array.from({ length: 60 }, (_, i) => 62 + i).join(), "second contents links");
});

await test("outputs open in pdf.js with working links", async () => {
  const { bytes } = await open(await buildFromPlan([file()], [{ file: 0, page: 0, rotate: 0 }, { file: 0, page: 7, rotate: 0 }]));
  const pdf = await openPdf(bytes);
  const annots = await (await pdf.getPage(1)).getAnnotations();
  eq(annots.length, 1, "links on the contents page");
  eq(await pdf.getPageIndex(annots[0].dest[0]), 1, "link target page");
  await pdf.loadingTask.destroy();
});

// ── Loading (P1-03): every tool opens a file the way readers do.
const fx = corpus(["enc-aes256-owner.pdf", "enc-rc4-40-owner.pdf", "enc-aes256-user.pdf", "dup-ids.pdf", "odd-boxes.pdf", "zero-pages.pdf", "cyclic-tree.pdf", "base.pdf", "acroform-unicode.pdf", "attachments.pdf", "xfa.pdf"]);
const { compress } = await load("optimize");
const { pdfToPdfa, pdfToExcel } = await load("convert");
const { redact } = await load("security");
const fxFile = (name, as = name) => file(fx[name], as);
// pdf.js's page count and text of an output.
async function readable(blob) {
  const pdf = await openPdf(new Uint8Array(await blob.arrayBuffer()));
  let text = "";
  for (let i = 1; i <= pdf.numPages; i++) text += (await (await pdf.getPage(i)).getTextContent()).items.map((t) => t.str).join(" ") + "\n";
  const pages = pdf.numPages;
  await pdf.loadingTask.destroy();
  return { pages, text };
}
const RUNS = {
  compress: async (f) => (await compress(f, { level: "recommended" }))[0].blob,
  merge: async (f) => (await merge([f], { bookmarks: false }))[0].blob,
  rotate: async (f) => (await rotateAll(f, 90))[0].blob,
  pdfa: async (f) => (await pdfToPdfa(f, { pdfaDpi: "150", keepText: true }))[0].blob,
  redact: async (f) => (await redact(f, [{ page: 2, rect: { x: 0, y: 0.9, w: 0.1, h: 0.1 } }], { redactDpi: "150" }))[0].blob,
  split: async (f) => (await buildFromPlan([f], [{ file: 0, page: 0, rotate: 0 }, { file: 0, page: 1, rotate: 0 }, { file: 0, page: 2, rotate: 0 }])),
};
for (const fixture of ["enc-aes256-owner.pdf", "enc-rc4-40-owner.pdf"]) {
  for (const [tool, run] of Object.entries(RUNS)) {
    await test(`${tool} opens ${fixture} (an owner password only) like any reader`, async () => {
      const { pages, text } = await readable(await run(fxFile(fixture)));
      eq(pages, 3, "pages");
      eq(text.includes("ALPHA1"), true, "text ALPHA1");
    });
  }
}
await test("the result says when the owner password's restrictions were left behind", async () => {
  eq((await rotateAll(fxFile("enc-aes256-owner.pdf"), 90))[0].note, "unrestricted", "note for an owner-password file");
  eq((await merge([fxFile("base.pdf"), fxFile("enc-rc4-40-owner.pdf")], { bookmarks: false }))[0].note, "unrestricted", "note for a merge");
  eq((await rotateAll(fxFile("base.pdf"), 90))[0].note, undefined, "no note for a plain file");
});
await test("a file that needs an open password is still refused, as encrypted", async () => {
  let error;
  try {
    await rotateAll(fxFile("enc-aes256-user.pdf"), 90);
  } catch (e) {
    error = e;
  }
  eq(error?.code, "encrypted", "error code");
});
// Redact isn't here: its output comes from pdfium, which follows the
// cross-reference table, so it showed the right text before P1-03 too.
for (const [tool, run] of Object.entries(RUNS).filter(([tool]) => tool !== "redact")) {
  await test(`${tool} on duplicate object numbers shows what readers show`, async () => {
    const { text } = await readable(await run(fxFile("dup-ids.pdf")).catch(async (e) => {
      // Organize keeps 3 pages; dup-ids has one.
      if (tool === "split") return buildFromPlan([fxFile("dup-ids.pdf")], [{ file: 0, page: 0, rotate: 0 }]);
      throw e;
    }));
    eq(text.includes("XREFTEXT"), true, "XREFTEXT shown");
    eq(text.includes("SHADOWTEXT"), false, "SHADOWTEXT shown");
  });
}
// Big plain files skip the qpdf pass (it rewrites the whole file, seconds for
// a few hundred megabytes); anything pdf-lib could read differently from a
// reader still goes through it. The threshold drops to 0 here.
await test("big plain files open without qpdf; encrypted or duplicate-numbered ones still use it", async () => {
  const open_ = await load("open");
  const keep = open_.directOpen.minBytes;
  open_.directOpen.minBytes = 0;
  try {
    const plain = new Uint8Array(fx["base.pdf"]);
    eq((await open_.openForEdit(plain)).bytes === plain, true, "a plain file is read as it is");
    for (const name of ["dup-ids.pdf", "enc-aes256-owner.pdf"]) {
      const input = new Uint8Array(fx[name]);
      eq((await open_.openForEdit(input)).bytes === input, false, `${name} goes through qpdf`);
    }
    const { text } = await readable(await buildFromPlan([fxFile("dup-ids.pdf")], [{ file: 0, page: 0, rotate: 0 }]));
    eq(text.includes("XREFTEXT") && !text.includes("SHADOWTEXT"), true, "dup-ids shows what readers show");
  } finally {
    open_.directOpen.minBytes = keep;
  }
});
await test("rotating pages with /Rotate 45 turns them from where readers show them", async () => {
  const [out] = await rotateAll(fxFile("odd-boxes.pdf"), 90);
  const pdf = await openPdf(new Uint8Array(await out.blob.arrayBuffer()));
  const ref = await openPdf(fx["odd-boxes.pdf"].slice());
  for (let i = 1; i <= ref.numPages; i++) eq((await pdf.getPage(i)).rotate, ((await ref.getPage(i)).rotate + 90) % 360, `page ${i} rotation`);
  await pdf.loadingTask.destroy();
  await ref.loadingTask.destroy();
});
await test("organize turns a /Rotate 45 page from where readers show it", async () => {
  const doc = await PDFDocument.load(fx["odd-boxes.pdf"]);
  const odd = doc.getPages().findIndex((p) => p.getRotation().angle % 90);
  if (odd < 0) throw new Error("odd-boxes.pdf has no page with an odd /Rotate");
  const { doc: out } = await open(await buildFromPlan([fxFile("odd-boxes.pdf")], [{ file: 0, page: odd, rotate: 90 }]));
  eq(out.getPage(0).getRotation().angle, 90, "rotation");
});
for (const [label, run] of [["merge", (f) => merge([f, fxFile("base.pdf")], { bookmarks: true })], ["split", (f) => split(f, { splitMode: "every", every: 1, ranges: "", maxMb: 1, mergeRanges: false })], ["rotate", (f) => rotateAll(f, 90)], ["redact", (f) => redact(f, [], { redactDpi: "150" })], ["compress", (f) => compress(f, { level: "recommended" })]]) {
  await test(`${label} refuses a file with no pages, as no_pages`, async () => {
    let error;
    try {
      await run(fxFile("zero-pages.pdf"));
    } catch (e) {
      error = e;
    }
    eq(error?.code, "no_pages", "error code");
  });
}
await test("a looped page tree is refused as damaged, not a stack overflow", async () => {
  let error;
  try {
    await split(fxFile("cyclic-tree.pdf"), { splitMode: "every", every: 1, ranges: "", maxMb: 1, mergeRanges: false });
  } catch (e) {
    error = e;
  }
  eq(error?.code, "damaged", `error code (${error?.message})`);
});
await test("PDF to Excel, one sheet per document, takes any file name", async () => {
  for (const name of ["Q1: report [final]?.pdf", "'quoted'.pdf", "History.pdf", "a/b\\c*d.pdf", `${"x".repeat(40)}].pdf`]) {
    const [out] = await pdfToExcel(fxFile("base.pdf", name), { sheetPer: "document" });
    eq(out.blob.size > 0 && /\.xlsx$/.test(out.name), true, `${name}: an xlsx`);
  }
});

// ── Merge keeps what a document carries beyond its pages (P1-04).
async function extras(blob) {
  const pdf = await openPdf(new Uint8Array(await blob.arrayBuffer()));
  const fields = await pdf.getFieldObjects();
  const attachments = await pdf.getAttachments();
  const outline = await pdf.getOutline();
  const walk = async (items) => Promise.all((items ?? []).map(async (it) => ({
    title: it.title,
    page: it.dest ? await pdf.getPageIndex((typeof it.dest === "string" ? await pdf.getDestination(it.dest) : it.dest)[0]).catch(() => null) : null,
    items: await walk(it.items),
  })));
  const tree = await walk(outline);
  const pages = pdf.numPages;
  await pdf.loadingTask.destroy();
  // pdf.js gives a Map or a plain object, depending on the version.
  const keys = (m) => (!m ? [] : m instanceof Map ? [...m.keys()] : Object.keys(m));
  return { fields: keys(fields), attachments: keys(attachments), tree, pages };
}
await test("merge keeps form fields, each copy a field of its own", async () => {
  const before = await extras(new Blob([fx["acroform-unicode.pdf"]]));
  if (before.fields.length < 5) throw new Error(`the fixture has ${before.fields.length} fields`);
  const [out] = await merge([fxFile("acroform-unicode.pdf"), fxFile("acroform-unicode.pdf", "again.pdf")], { bookmarks: true });
  const after = await extras(out.blob);
  eq(after.fields.length >= 5, true, `fields ${JSON.stringify(after.fields)}`);
  eq(after.fields.length, before.fields.length * 2, "fields (the second copy's renamed)");
  // pdf-lib (a second reader) finds both copies' fields too.
  const fieldsIn = async (bytes) => (await PDFDocument.load(bytes)).getForm().getFields().length;
  eq(await fieldsIn(new Uint8Array(await out.blob.arrayBuffer())), 2 * await fieldsIn(fx["acroform-unicode.pdf"]), "pdf-lib fields");
});
await test("merge keeps an XFA form's fields (the XFA packet can't be combined)", async () => {
  const [out] = await merge([fxFile("xfa.pdf"), fxFile("base.pdf")], { bookmarks: false });
  const after = await extras(out.blob);
  eq(after.fields.length >= 3, true, `fields ${JSON.stringify(after.fields)}`);
});
await test("merge keeps attached files", async () => {
  const [out] = await merge([fxFile("attachments.pdf"), fxFile("base.pdf")], { bookmarks: false });
  eq((await extras(out.blob)).attachments.length, 2, "attachments");
  const [twice] = await merge([fxFile("attachments.pdf"), fxFile("attachments.pdf", "again.pdf")], { bookmarks: false });
  eq((await extras(twice.blob)).attachments.length, 4, "attachments of both copies, renamed where they clash");
});
await test("merge nests each file's bookmarks under the file's own", async () => {
  const [out] = await merge([fxFile("base.pdf"), fxFile("base.pdf", "second.pdf")], { bookmarks: true });
  const { tree } = await extras(out.blob);
  eq(tree.map((t) => t.title).join(), "base,second", "file bookmarks");
  eq(tree[0].items.map((t) => t.title).join(), "Chapter 1,Chapter 2,Chapter 3", "first file's bookmarks");
  eq(tree[0].items.map((t) => t.page).join(), "0,1,2", "first file's targets");
  eq(tree[1].items.map((t) => t.page).join(), "3,4,5", "second file's targets");
  eq(tree[1].page, 3, "second file bookmark target");
});
await test("merge without file bookmarks still keeps each file's own", async () => {
  const [out] = await merge([fxFile("base.pdf"), fxFile("base.pdf", "second.pdf")], { bookmarks: false });
  const { tree } = await extras(out.blob);
  eq(tree.map((t) => `${t.title}@${t.page}`).join(), "Chapter 1@0,Chapter 2@1,Chapter 3@2,Chapter 1@3,Chapter 2@4,Chapter 3@5", "bookmarks");
});
await test("organize with several files keeps fields, attachments and bookmarks of the pages kept", async () => {
  const blob = await buildFromPlan([fxFile("base.pdf"), fxFile("acroform-unicode.pdf"), fxFile("attachments.pdf")], [
    { file: 0, page: 2, rotate: 0 }, { file: 1, page: 0, rotate: 0 }, { file: 0, page: 0, rotate: 0 }, { file: 2, page: 0, rotate: 0 },
  ]);
  const { tree, fields, attachments, pages } = await extras(blob);
  eq(pages, 4, "pages");
  // Chapter 2's page was left out, so its bookmark goes too.
  eq(tree.map((t) => `${t.title}@${t.page}`).join(), "Chapter 1@2,Chapter 3@0", "bookmarks");
  eq(fields.length >= 5, true, `fields ${JSON.stringify(fields)}`);
  eq(attachments.length, 2, "attachments");
});

// A Type 3 font with no /Resources of its own draws its glyphs with the
// page's resources (ISO 32000-1, 9.6.5), so what its glyphs name stays.
await test("a part keeps what a Type 3 font's glyphs draw from the page's resources", async () => {
  const doc = await PDFDocument.create();
  const ctx = doc.context;
  const img = ctx.register(ctx.stream(new Uint8Array(3 * 4 * 4).fill(200), { Type: "XObject", Subtype: "Image", Width: 4, Height: 4, ColorSpace: "DeviceRGB", BitsPerComponent: 8 }));
  const proc = ctx.register(ctx.stream("1000 0 0 0 1000 1000 d1 q 1000 0 0 1000 0 0 cm /GlyphImg Do Q"));
  const t3 = ctx.register(ctx.obj({
    Type: "Font", Subtype: "Type3", FontBBox: [0, 0, 1000, 1000], FontMatrix: [0.001, 0, 0, 0.001, 0, 0], CharProcs: { a: proc },
    Encoding: { Type: "Encoding", Differences: [97, PDFName.of("a")] }, FirstChar: 97, LastChar: 97, Widths: [1000],
  }));
  const res = ctx.register(ctx.obj({ Font: { T3: t3 }, XObject: { GlyphImg: img } }));
  for (let i = 0; i < 2; i++) {
    const p = doc.addPage([300, 300]);
    p.node.set(PDFName.of("Resources"), res);
    p.node.set(PDFName.of("Contents"), ctx.register(ctx.stream("BT /T3 50 Tf 50 50 Td (a) Tj ET")));
  }
  const bytes = await doc.save();
  const parts = await split(file(bytes, "t3.pdf"), { splitMode: "every", every: 1, ranges: "", maxMb: 1, mergeRanges: false });
  for (let i = 0; i < parts.length; i++) eq(images((await open(parts[i].blob)).doc), 1, `part ${i + 1} images`);
  eq(images((await open(await buildFromPlan([file(bytes, "t3.pdf")], [{ file: 0, page: 1, rotate: 0 }]))).doc), 1, "organized page images");
});

// Bookmarks nested thousands deep (a chain, each the only child of the last).
async function deepOutline(depth) {
  const doc = await PDFDocument.create();
  const ctx = doc.context;
  const page = doc.addPage([300, 300]);
  const root = ctx.nextRef();
  const refs = Array.from({ length: depth }, () => ctx.nextRef());
  refs.forEach((r, i) => ctx.assign(r, ctx.obj({
    Title: PDFHexString.fromText(`L${i}`), Parent: i ? refs[i - 1] : root, Dest: [page.ref, PDFName.of("Fit")],
    ...(i < depth - 1 ? { First: refs[i + 1], Last: refs[i + 1], Count: PDFNumber.of(1) } : {}),
  })));
  ctx.assign(root, ctx.obj({ Type: "Outlines", First: refs[0], Last: refs[0], Count: PDFNumber.of(1) }));
  doc.catalog.set(PDFName.of("Outlines"), root);
  return doc.save();
}
await test("bookmarks nested 3000 deep don't stop merge or organize", async () => {
  const bytes = await deepOutline(3000);
  const [merged] = await merge([file(bytes, "deep.pdf"), file(bytes, "deep2.pdf")], { bookmarks: true });
  const { tree, pages } = await extras(merged.blob);
  eq(pages, 2, "merged pages");
  eq(tree.map((t) => t.title).join(), "deep,deep2", "file bookmarks");
  const organized = await extras(await buildFromPlan([file(bytes, "deep.pdf")], [{ file: 0, page: 0, rotate: 0 }]));
  eq(organized.tree[0]?.title, "L0", "top bookmark kept");
});

process.exit(results.failed ? 1 : 0);
