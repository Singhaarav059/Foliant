// Builds the hostile-input corpus: damaged structure, revisions, duplicate
// ids, odd page trees and boxes, every encryption flavour, forms and XFA,
// attachments, size extremes, unusual image codecs and decompression bombs.
// Every fixture is generated here, deterministically, from code (nothing
// binary is checked in), and opened with the reference reader (pdf.js) so a
// fixture that is broken in an unintended way shows up in manifest.json.
//
//   node tests/robustness/gen.mjs <dir> [name-filter-regex]
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import zlib from "node:zlib";
import { load, refInfo, require, vendorDir, ROOT } from "./env.mjs";
import { encodeG4 } from "./g4.mjs";

const {
  PDFDocument, PDFName, PDFString, PDFHexString, PDFNumber, StandardFonts, degrees,
} = await import("pdf-lib");
const fontkit = (await import("@pdf-lib/fontkit")).default;
const sharp = require("sharp");
const { runQpdf } = await load("qpdf");
const { srgbProfile } = await load("icc");

const OUT = process.argv[2];
if (!OUT) throw new Error("usage: node tests/robustness/gen.mjs <dir> [filter]");
mkdirSync(OUT, { recursive: true });
const only = process.argv[3] ? new RegExp(process.argv[3]) : null;
const manifest = {};

async function put(name, bytes, meta = {}) {
  bytes = new Uint8Array(bytes);
  writeFileSync(join(OUT, name), bytes);
  let ref;
  try {
    ref = await refInfo(bytes, meta.password);
    ref = { numPages: ref.numPages, firstText: ref.pages[0]?.text.slice(0, 80) ?? "", annots: ref.pages.flatMap((p) => p.annots).length, attachments: ref.attachments, fields: ref.fields, outline: ref.outline };
  } catch (e) {
    ref = { error: `${e.name}: ${e.message}`.slice(0, 160) };
  }
  manifest[name] = { size: bytes.length, ...meta, ref };
  console.log(name.padEnd(28), String(bytes.length).padStart(10), JSON.stringify(ref).slice(0, 140));
}
const want = (name) => !only || only.test(name);

// ── Raw PDF writer: objects in order, a correct xref, so breakage is deliberate.
const B = (s) => Buffer.from(s, "latin1");
function stream(dict, data, filter) {
  let body = Buffer.isBuffer(data) ? data : B(data);
  if (filter === "flate") body = zlib.deflateSync(body);
  return Buffer.concat([B(`<< ${dict}${filter === "flate" ? " /Filter /FlateDecode" : ""} /Length ${body.length} >>\nstream\n`), body, B("\nendstream")]);
}
function raw(objs, { root = 1, header = "%PDF-1.7", trailerExtra = "", info } = {}) {
  const parts = [B(`${header}\n%\xe2\xe3\xcf\xd3\n`)];
  let pos = parts[0].length;
  const offsets = {};
  let max = 0;
  for (const [num, body] of objs) {
    const chunk = Buffer.concat([B(`${num} 0 obj\n`), Buffer.isBuffer(body) ? body : B(body), B("\nendobj\n")]);
    if (!(num in offsets)) offsets[num] = pos; // first definition wins in the xref
    pos += chunk.length;
    parts.push(chunk);
    max = Math.max(max, num);
  }
  const xrefAt = pos;
  let xref = `xref\n0 ${max + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= max; i++) xref += i in offsets ? `${String(offsets[i]).padStart(10, "0")} 00000 n \n` : "0000000000 65535 f \n";
  xref += `trailer\n<< /Size ${max + 1} /Root ${root} 0 R${info ? ` /Info ${info} 0 R` : ""}${trailerExtra} >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  parts.push(B(xref));
  return { bytes: Buffer.concat(parts), offsets, xrefAt, size: max + 1 };
}
const text = (s, x = 72, y = 700, size = 14, font = "F1") => `BT /${font} ${size} Tf ${x} ${y} Td (${s}) Tj ET`;
const helv = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";

// ── base.pdf: three pages of known words, links, a note, an outline.
async function base({ objectStreams = true } = {}) {
  const doc = await PDFDocument.create();
  doc.setTitle("Base fixture");
  doc.setAuthor("Fuzz");
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const ctx = doc.context;
  const pages = [];
  for (let p = 1; p <= 3; p++) {
    const page = doc.addPage([612, 792]);
    page.drawText(`ALPHA${p} page ${p} body text quick brown fox`, { x: 72, y: 700, size: 14, font });
    page.drawText(`SECRET${p}-4471 account number`, { x: 72, y: 650, size: 14, font });
    page.drawText(`Footer BRAVO${p}`, { x: 72, y: 60, size: 10, font });
    pages.push(page);
  }
  const uri = ctx.register(ctx.obj({ Type: "Annot", Subtype: "Link", Rect: [72, 695, 300, 715], Border: [0, 0, 0], A: { S: "URI", URI: PDFString.of("https://example.com/alpha") } }));
  const go = ctx.register(ctx.obj({ Type: "Annot", Subtype: "Link", Rect: [72, 55, 200, 72], Border: [0, 0, 0], Dest: [pages[2].ref, PDFName.of("XYZ"), null, null, null] }));
  pages[0].node.set(PDFName.of("Annots"), ctx.obj([uri, go]));
  const note = ctx.register(ctx.obj({ Type: "Annot", Subtype: "Text", Rect: [400, 700, 420, 720], Contents: PDFString.of("Sticky NOTE text"), Open: false }));
  pages[1].node.set(PDFName.of("Annots"), ctx.obj([note]));
  const outlineRef = ctx.nextRef();
  const refs = pages.map(() => ctx.nextRef());
  pages.forEach((p, i) => {
    const item = { Title: PDFHexString.fromText(`Chapter ${i + 1}`), Parent: outlineRef, Dest: [p.ref, PDFName.of("Fit")] };
    if (i > 0) item.Prev = refs[i - 1];
    if (i < 2) item.Next = refs[i + 1];
    ctx.assign(refs[i], ctx.obj(item));
  });
  ctx.assign(outlineRef, ctx.obj({ Type: "Outlines", First: refs[0], Last: refs[2], Count: 3 }));
  doc.catalog.set(PDFName.of("Outlines"), outlineRef);
  return doc.save({ useObjectStreams: objectStreams });
}

const plainBase = Buffer.from(await base({ objectStreams: false }));
if (want("base.pdf")) await put("base.pdf", await base(), { words: ["ALPHA1", "ALPHA2", "ALPHA3", "BRAVO2"], secret: "SECRET1-4471" });
if (want("base-classic.pdf")) await put("base-classic.pdf", plainBase, { words: ["ALPHA1", "ALPHA2", "ALPHA3"], secret: "SECRET1-4471" });

// ── Damaged structure
if (want("truncated-70.pdf")) await put("truncated-70.pdf", plainBase.subarray(0, Math.floor(plainBase.length * 0.7)), { words: ["ALPHA1"] });
if (want("truncated-tail.pdf")) await put("truncated-tail.pdf", plainBase.subarray(0, plainBase.lastIndexOf(B("xref"))), { words: ["ALPHA1", "ALPHA3"] });
if (want("bad-xref-offsets.pdf")) {
  const s = plainBase.toString("latin1");
  const at = s.lastIndexOf("xref");
  const fixed = s.slice(0, at) + s.slice(at).replace(/^(\d{10}) (\d{5}) n/gm, (_, o, g) => `${String(Number(o) + 13).padStart(10, "0")} ${g} n`);
  await put("bad-xref-offsets.pdf", B(fixed), { words: ["ALPHA1", "ALPHA3"] });
}
if (want("startxref-garbage.pdf")) {
  const s = plainBase.toString("latin1").replace(/startxref\s+\d+/, "startxref\n999999");
  await put("startxref-garbage.pdf", B(s), { words: ["ALPHA1", "ALPHA3"] });
}
if (want("trailer-no-root.pdf")) {
  const s = plainBase.toString("latin1").replace(/\/Root \d+ 0 R/, "");
  await put("trailer-no-root.pdf", B(s), { words: ["ALPHA1", "ALPHA3"] });
}
if (want("garbage-prefix.pdf")) {
  const junk = B("From: mailer\r\nContent-Type: application/pdf\r\n\r\n" + "x".repeat(1500) + "\r\n");
  await put("garbage-prefix.pdf", Buffer.concat([junk, plainBase]), { words: ["ALPHA1", "ALPHA3"] });
}

// ── Revisions: a raw two-page file, then an appended update that rewrites
// page 1's text and adds a third page.
function twoPage(t1 = "ORIGINALTEXT first page", t2 = "SECONDPAGE text") {
  return raw([
    [1, "<< /Type /Catalog /Pages 2 0 R >>"],
    [2, "<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 >>"],
    [3, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>"],
    [4, stream("", text(t1))],
    [5, helv],
    [6, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 7 0 R /Resources << /Font << /F1 5 0 R >> >> >>"],
    [7, stream("", text(t2))],
  ]);
}
function update(prev, xrefStream) {
  const objs = [
    [4, stream("", text("UPDATEDTEXT first page"))],
    [2, "<< /Type /Pages /Kids [3 0 R 6 0 R 8 0 R] /Count 3 >>"],
    [8, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 9 0 R /Resources << /Font << /F1 5 0 R >> >> >>"],
    [9, stream("", text("THIRDPAGE added later"))],
  ];
  const parts = [prev.bytes];
  let pos = prev.bytes.length;
  const offs = {};
  for (const [n, body] of objs) {
    const chunk = Buffer.concat([B(`\n${n} 0 obj\n`), Buffer.isBuffer(body) ? body : B(body), B("\nendobj\n")]);
    offs[n] = pos + 1;
    pos += chunk.length;
    parts.push(chunk);
  }
  if (!xrefStream) {
    const xref = `xref\n0 1\n0000000000 65535 f \n2 1\n${String(offs[2]).padStart(10, "0")} 00000 n \n4 1\n${String(offs[4]).padStart(10, "0")} 00000 n \n8 2\n${String(offs[8]).padStart(10, "0")} 00000 n \n${String(offs[9]).padStart(10, "0")} 00000 n \ntrailer\n<< /Size 10 /Root 1 0 R /Prev ${prev.xrefAt} >>\nstartxref\n${pos}\n%%EOF\n`;
    parts.push(B(xref));
  } else {
    // Cross-reference stream (object 10) with W [1 4 2].
    const rows = [[2, offs[2]], [4, offs[4]], [8, offs[8]], [9, offs[9]], [10, pos]];
    const data = Buffer.concat(rows.map(([, o]) => { const b = Buffer.alloc(7); b[0] = 1; b.writeUInt32BE(o, 1); return b; }));
    const idx = "2 1 4 1 8 3";
    parts.push(B("10 0 obj\n"), stream(`/Type /XRef /Size 11 /W [1 4 2] /Index [${idx}] /Root 1 0 R /Prev ${prev.xrefAt}`, data), B(`\nendobj\nstartxref\n${pos}\n%%EOF\n`));
  }
  return Buffer.concat(parts);
}
if (want("incremental.pdf")) await put("incremental.pdf", update(twoPage(), false), { words: ["UPDATEDTEXT", "SECONDPAGE", "THIRDPAGE"], stale: "ORIGINALTEXT" });
if (want("incremental-xrefstm.pdf")) await put("incremental-xrefstm.pdf", update(twoPage(), true), { words: ["UPDATEDTEXT", "SECONDPAGE", "THIRDPAGE"], stale: "ORIGINALTEXT" });

// Duplicate object numbers in the body; the xref points at the first copy.
if (want("dup-ids.pdf")) {
  const r = raw([
    [1, "<< /Type /Catalog /Pages 2 0 R >>"],
    [2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>"],
    [3, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>"],
    [4, stream("", text("XREFTEXT shown by readers that follow the xref"))],
    [5, helv],
    [4, stream("", text("SHADOWTEXT later duplicate object"))],
  ]);
  await put("dup-ids.pdf", r.bytes, { words: ["XREFTEXT"], stale: "SHADOWTEXT" });
}

// ── Page trees
if (want("zero-pages.pdf")) await put("zero-pages.pdf", raw([[1, "<< /Type /Catalog /Pages 2 0 R >>"], [2, "<< /Type /Pages /Kids [] /Count 0 >>"]]).bytes);
if (want("deep-tree.pdf")) {
  const depth = 3000;
  const objs = [[1, "<< /Type /Catalog /Pages 2 0 R >>"]];
  for (let d = 0; d < depth; d++) objs.push([2 + d, `<< /Type /Pages ${d ? `/Parent ${1 + d} 0 R ` : ""}/Kids [${3 + d} 0 R] /Count 1 >>`]);
  const leaf = 2 + depth;
  objs.push([leaf, `<< /Type /Page /Parent ${leaf - 1} 0 R /MediaBox [0 0 612 792] /Contents ${leaf + 1} 0 R /Resources << /Font << /F1 ${leaf + 2} 0 R >> >> >>`]);
  objs.push([leaf + 1, stream("", text("DEEPTREE leaf page"))]);
  objs.push([leaf + 2, helv]);
  await put("deep-tree.pdf", raw(objs).bytes, { words: ["DEEPTREE"] });
}
if (want("cyclic-tree.pdf")) {
  await put("cyclic-tree.pdf", raw([
    [1, "<< /Type /Catalog /Pages 2 0 R >>"],
    [2, "<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 >>"],
    [3, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>"],
    [4, stream("", text("CYCLEPAGE one"))],
    [5, helv],
    [6, "<< /Type /Pages /Parent 2 0 R /Kids [2 0 R] /Count 1 >>"],
  ]).bytes, { words: ["CYCLEPAGE"] });
}

// ── Malformed content streams, one problem per page.
if (want("malformed-content.pdf")) {
  const contents = [
    "q q q 1 0 0 1 50 50 cm " + text("UNBALANCED q page"),
    "foo bar 12 baz BT /F1 14 Tf 72 700 Td (NOENDTEXT page) Tj",
    null, // corrupt Flate
    "1e999 0 0 1 0 0 cm NaN 3 re f " + text("HUGECM page"),
    text("INLINEIMG page") + " BI /W 100 /H 100 /CS /G /BPC 8 ID \x00\x01\x02",
    text("MISSINGFONT page", 72, 700, 14, "F99"),
    text("MISSINGREF page"),
  ];
  const objs = [[1, "<< /Type /Catalog /Pages 2 0 R >>"], [3, helv]];
  const kids = [];
  let n = 10;
  contents.forEach((c, i) => {
    const page = n++, cs = n++;
    kids.push(`${page} 0 R`);
    const contentsRef = i === 6 ? `[${cs} 0 R 9999 0 R]` : `${cs} 0 R`;
    objs.push([page, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${contentsRef} /Resources << /Font << /F1 3 0 R >> >> >>`]);
    if (c === null) objs.push([cs, Buffer.concat([B("<< /Filter /FlateDecode /Length 64 >>\nstream\n"), Buffer.from(Array.from({ length: 64 }, (_, k) => (k * 37 + 11) & 255)), B("\nendstream")])]);
    else objs.push([cs, stream("", c, "flate")]);
  });
  objs.splice(1, 0, [2, `<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${kids.length} >>`]);
  await put("malformed-content.pdf", raw(objs).bytes, { words: ["UNBALANCED", "HUGECM", "MISSINGREF"] });
}

// ── Fonts
if (want("type3.pdf")) {
  const box = "0 0 0 0 600 700 d1 50 0 500 700 re f";
  const tri = "0 0 0 0 600 700 d1 50 0 m 300 700 l 550 0 l f";
  await put("type3.pdf", raw([
    [1, "<< /Type /Catalog /Pages 2 0 R >>"],
    [2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>"],
    [3, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /T3 5 0 R /F1 9 0 R >> >> >>"],
    [4, stream("", "BT /T3 24 Tf 72 700 Td (ABBA) Tj ET " + text("Helvetica LINE beside Type3", 72, 600))],
    [5, "<< /Type /Font /Subtype /Type3 /FontBBox [0 0 600 700] /FontMatrix [0.001 0 0 0.001 0 0] /CharProcs << /A 6 0 R /B 7 0 R >> /Encoding << /Type /Encoding /Differences [65 /A /B] >> /FirstChar 65 /LastChar 66 /Widths [600 600] /ToUnicode 8 0 R /Resources << >> >>"],
    [6, stream("", box)],
    [7, stream("", tri)],
    [8, stream("", "/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CMapName /T3 def 1 begincodespacerange <00> <FF> endcodespacerange 2 beginbfchar <41> <0041> <42> <0042> endbfchar endcmap CMapName currentdict /CMap defineresource pop end end")],
    [9, helv],
  ]).bytes, { words: ["ABBA", "LINE"] });
}
if (want("nonembedded.pdf")) {
  // Arial and Garamond by name only; a CID font addressed through the predefined UniJIS-UCS2-H CMap.
  const ucs = Buffer.from([0x65, 0xe5, 0x67, 0x2c, 0x8a, 0x9e]); // 日本語
  const jp = Buffer.concat([B("BT /F3 28 Tf 72 560 Td <"), B(ucs.toString("hex")), B("> Tj ET")]);
  await put("nonembedded.pdf", raw([
    [1, "<< /Type /Catalog /Pages 2 0 R >>"],
    [2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>"],
    [3, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R /F2 6 0 R /F3 7 0 R >> >> >>"],
    [4, stream("", Buffer.concat([B(text("ARIALNOTEMBEDDED text", 72, 700, 18) + " " + text("GARAMONDNOTEMBEDDED text", 72, 640, 18, "F2") + " "), jp]))],
    [5, "<< /Type /Font /Subtype /TrueType /BaseFont /Arial /Encoding /WinAnsiEncoding /FirstChar 32 /LastChar 126 /FontDescriptor 8 0 R >>"],
    [6, "<< /Type /Font /Subtype /Type1 /BaseFont /Garamond /Encoding /WinAnsiEncoding >>"],
    [7, "<< /Type /Font /Subtype /Type0 /BaseFont /MS-Mincho /Encoding /UniJIS-UCS2-H /DescendantFonts [9 0 R] >>"],
    [8, "<< /Type /FontDescriptor /FontName /Arial /Flags 32 /FontBBox [-665 -325 2000 1006] /ItalicAngle 0 /Ascent 905 /Descent -212 /CapHeight 716 /StemV 80 >>"],
    [9, "<< /Type /Font /Subtype /CIDFontType2 /BaseFont /MS-Mincho /CIDSystemInfo << /Registry (Adobe) /Ordering (Japan1) /Supplement 2 >> /FontDescriptor 10 0 R /DW 1000 >>"],
    [10, "<< /Type /FontDescriptor /FontName /MS-Mincho /Flags 6 /FontBBox [0 -141 1000 859] /ItalicAngle 0 /Ascent 859 /Descent -141 /CapHeight 769 /StemV 78 >>"],
  ]).bytes, { words: ["ARIALNOTEMBEDDED", "GARAMONDNOTEMBEDDED", "日本語"] });
}

// Scripts with embedded Noto subsets (the product's own vendored slices).
const fontsJson = JSON.parse(readFileSync(join(vendorDir, "fonts/fonts.json"), "utf8"));
function faceFor(cp, weight = 400) {
  for (const group of Object.values(fontsJson)) for (const f of group) {
    if (f.weight !== weight) continue;
    for (let i = 0; i < f.ranges.length; i += 2) if (cp >= f.ranges[i] && cp <= f.ranges[i + 1]) return f.file;
  }
  return null;
}
if (want("scripts.pdf")) {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const page = doc.addPage([612, 792]);
  const lines = [["Devanagari", "नमस्ते दुनिया"], ["Arabic", "مرحبا بالعالم"], ["Chinese", "你好世界"], ["Japanese", "こんにちは"], ["Cyrillic", "Привет мир"]];
  let y = 700;
  const latin = await doc.embedFont(StandardFonts.Helvetica);
  const embedded = {};
  for (const [label, s] of lines) {
    page.drawText(label + ":", { x: 72, y, size: 14, font: latin });
    // One run per font slice, drawn left to right.
    const runs = [];
    for (const ch of s) {
      const file = ch === " " ? runs.at(-1)?.file : faceFor(ch.codePointAt(0));
      if (runs.length && runs.at(-1).file === file) runs.at(-1).text += ch;
      else runs.push({ file, text: ch });
    }
    let x = 200;
    for (const r of runs) {
      if (!r.file) continue;
      const f = (embedded[r.file] ??= await doc.embedFont(readFileSync(join(vendorDir, "fonts", r.file)), { subset: true }));
      try { page.drawText(r.text, { x, y, size: 18, font: f }); x += f.widthOfTextAtSize(r.text, 18); } catch (e) { console.log("  scripts: skip", label, e.message); }
    }
    y -= 50;
  }
  await put("scripts.pdf", await doc.save(), { words: ["Devanagari", "Chinese", "你好世界", "Привет"] });
}

// ── Forms
if (want("acroform-unicode.pdf")) {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const page = doc.addPage([612, 792]);
  const form = doc.getForm();
  const latin = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText("FORMPAGE with fields", { x: 72, y: 740, size: 14, font: latin });
  const dev = await doc.embedFont(readFileSync(join(vendorDir, "fonts", faceFor(0x928))), { subset: false });
  const t1 = form.createTextField("名前");
  t1.addToPage(page, { x: 72, y: 650, width: 300, height: 30, font: dev });
  t1.setText("नमस्ते");
  t1.updateAppearances(dev);
  const t2 = form.createTextField("plain.ascii");
  t2.setText("FIELDVALUE ascii");
  t2.addToPage(page, { x: 72, y: 600, width: 300, height: 30, font: latin });
  const cb = form.createCheckBox("agree✓");
  cb.addToPage(page, { x: 72, y: 550, width: 20, height: 20 });
  cb.check();
  const dd = form.createDropdown("città");
  dd.addOptions(["Zürich", "Köln", "Ålesund"]);
  dd.select("Köln");
  dd.addToPage(page, { x: 72, y: 500, width: 200, height: 30, font: latin });
  await put("acroform-unicode.pdf", await doc.save({ updateFieldAppearances: false }), { words: ["FORMPAGE"], fields: 4 });
}
if (want("xfa.pdf")) {
  const first = await PDFDocument.create();
  const font = await first.embedFont(StandardFonts.Helvetica);
  const page = first.addPage([612, 792]);
  page.drawText("XFAPLACEHOLDER Please wait... If this message is not eventually replaced", { x: 40, y: 700, size: 11, font });
  const f = first.getForm().createTextField("form1[0].page1[0].name[0]");
  f.addToPage(page, { x: 72, y: 600, width: 200, height: 24, font });
  // Reload without touching getForm() (pdf-lib strips XFA whenever the form is accessed).
  const doc = await PDFDocument.load(await first.save());
  const ctx = doc.context;
  const xdp = (s) => ctx.register(ctx.flateStream(B(s)));
  const xfa = [
    PDFString.of("preamble"), xdp('<xdp:xdp xmlns:xdp="http://ns.adobe.com/xdp/">'),
    PDFString.of("template"), xdp('<template xmlns="http://www.xfa.org/schema/xfa-template/3.3/"><subform name="form1" layout="tb"><pageSet><pageArea name="Page1"><contentArea x="0.25in" y="0.25in" w="8in" h="10.5in"/><medium stock="letter" short="8.5in" long="11in"/></pageArea></pageSet><subform name="page1" w="8in" h="10in"><field name="name" w="3in" h="9mm"><ui><textEdit/></ui><caption><value><text>XFANAME</text></value></caption></field><draw name="t" w="5in" h="10mm"><value><text>XFADYNAMICTEXT only in XFA</text></value></draw></subform></subform></template>'),
    PDFString.of("datasets"), xdp('<xfa:datasets xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/"><xfa:data><form1><page1><name>XFADATA value</name></page1></form1></xfa:data></xfa:datasets>'),
    PDFString.of("postamble"), xdp("</xdp:xdp>"),
  ];
  doc.catalog.lookup(PDFName.of("AcroForm")).set(PDFName.of("XFA"), ctx.obj(xfa));
  doc.catalog.set(PDFName.of("NeedsRendering"), ctx.obj(true));
  await put("xfa.pdf", await doc.save({ useObjectStreams: false, updateFieldAppearances: false }), { words: ["XFAPLACEHOLDER"], fields: 1, xfa: true });
}

// ── Annotations, links, attachments
if (want("annots.pdf")) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const ctx = doc.context;
  const p1 = doc.addPage([612, 792]);
  const p2 = doc.addPage([612, 792]);
  p1.drawText("ANNOTPAGE one with highlight", { x: 72, y: 700, size: 14, font });
  p2.drawText("TARGETPAGE two", { x: 72, y: 700, size: 14, font });
  const ap = (w, h, ops) => ctx.register(ctx.stream(ops, { Type: "XObject", Subtype: "Form", BBox: [0, 0, w, h] }));
  const hl = ctx.register(ctx.obj({ Type: "Annot", Subtype: "Highlight", Rect: [70, 695, 300, 716], QuadPoints: [70, 716, 300, 716, 70, 695, 300, 695], C: [1, 1, 0], Contents: PDFString.of("HIGHLIGHTNOTE"), AP: { N: ap(230, 21, "1 1 0 rg 0 0 230 21 re f") }, CA: 0.4 }));
  const ink = ctx.register(ctx.obj({ Type: "Annot", Subtype: "Ink", Rect: [100, 400, 300, 500], InkList: [[100, 400, 200, 500, 300, 400]], C: [0, 0, 1], AP: { N: ap(200, 100, "0 0 1 RG 2 w 0 0 m 100 100 l 200 0 l S") } }));
  const free = ctx.register(ctx.obj({ Type: "Annot", Subtype: "FreeText", Rect: [72, 300, 372, 330], Contents: PDFString.of("FREETEXTANNOT words"), DA: PDFString.of("/Helv 12 Tf 0 g"), AP: { N: ap(300, 30, "BT /Helv 12 Tf 2 10 Td (FREETEXTANNOT words) Tj ET") } }));
  const sq = ctx.register(ctx.obj({ Type: "Annot", Subtype: "Square", Rect: [400, 400, 500, 500], C: [1, 0, 0], AP: { N: ap(100, 100, "1 0 0 RG 1 1 98 98 re S") } }));
  const stamp = ctx.register(ctx.obj({ Type: "Annot", Subtype: "Stamp", Name: PDFName.of("Approved"), Rect: [400, 200, 550, 250], AP: { N: ap(150, 50, "0 0.5 0 rg 0 0 150 50 re f") } }));
  const named = ctx.register(ctx.obj({ Type: "Annot", Subtype: "Link", Rect: [72, 600, 250, 620], Border: [0, 0, 0], Dest: PDFString.of("target") }));
  const gotoA = ctx.register(ctx.obj({ Type: "Annot", Subtype: "Link", Rect: [72, 560, 250, 580], Border: [0, 0, 0], A: { S: "GoTo", D: [p2.ref, PDFName.of("Fit")] } }));
  const launch = ctx.register(ctx.obj({ Type: "Annot", Subtype: "Link", Rect: [72, 520, 250, 540], Border: [0, 0, 0], A: { S: "URI", URI: PDFString.of("mailto:someone@example.com") } }));
  p1.node.set(PDFName.of("Annots"), ctx.obj([hl, ink, free, sq, stamp, named, gotoA, launch]));
  doc.catalog.set(PDFName.of("Names"), ctx.obj({ Dests: { Names: [PDFString.of("target"), ctx.obj([p2.ref, PDFName.of("XYZ"), 0, 792, null])] } }));
  await put("annots.pdf", await doc.save(), { words: ["ANNOTPAGE", "TARGETPAGE"] });
}
if (want("attachments.pdf")) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([612, 792]);
  page.drawText("ATTACHPAGE carries files", { x: 72, y: 700, size: 14, font });
  await doc.attach(B("hello,attachment\n1,2\n"), "data.csv", { mimeType: "text/csv", description: "CSV data" });
  await doc.attach(plainBase, "inner.pdf", { mimeType: "application/pdf" });
  const ctx = doc.context;
  const ef = ctx.register(ctx.flateStream(B("annotation attachment body"), { Type: "EmbeddedFile" }));
  const fs = ctx.register(ctx.obj({ Type: "Filespec", F: PDFString.of("note.txt"), UF: PDFHexString.fromText("note.txt"), EF: { F: ef } }));
  const fa = ctx.register(ctx.obj({ Type: "Annot", Subtype: "FileAttachment", Rect: [400, 700, 420, 720], FS: fs, Contents: PDFString.of("attached note") }));
  page.node.set(PDFName.of("Annots"), ctx.obj([fa]));
  await put("attachments.pdf", await doc.save(), { words: ["ATTACHPAGE"], attachments: 2 });
}

// ── Size extremes
if (want("pages-1500.pdf")) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= 1500; i++) doc.addPage([612, 792]).drawText(`MANYPAGES page ${i} of 1500`, { x: 72, y: 700, size: 14, font });
  await put("pages-1500.pdf", await doc.save(), { words: ["MANYPAGES"] });
}
if (want("huge-page.pdf")) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const p = doc.addPage([14400, 14400]);
  p.drawText("HUGEPAGE 200 by 200 inches", { x: 400, y: 13000, size: 400, font });
  p.drawText("SECRETHUGE corner", { x: 400, y: 1000, size: 300, font });
  await put("huge-page.pdf", await doc.save(), { words: ["HUGEPAGE", "SECRETHUGE"] });
}
if (want("tiny-page.pdf")) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const p = doc.addPage([3, 3]);
  p.drawText("T", { x: 0, y: 0, size: 2, font });
  await put("tiny-page.pdf", await doc.save(), {});
}

// ── Odd boxes and rotations: one page per case.
if (want("odd-boxes.pdf")) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const cases = [
    ["OFFSETMEDIA", (p) => { p.setMediaBox(100, 200, 612, 792); }],
    ["CROPSMALL", (p) => { p.setCropBox(150, 250, 300, 300); }],
    ["ROT90", (p) => p.setRotation(degrees(90))],
    ["ROT270CROP", (p) => { p.setRotation(degrees(270)); p.setCropBox(50, 60, 500, 600); }],
    ["ROTNEG90", (p) => p.node.set(PDFName.of("Rotate"), PDFNumber.of(-90))],
    ["ROT450", (p) => p.node.set(PDFName.of("Rotate"), PDFNumber.of(450))],
    ["ROT45", (p) => p.node.set(PDFName.of("Rotate"), PDFNumber.of(45))],
    ["INVERTEDMEDIA", (p) => p.node.set(PDFName.of("MediaBox"), doc.context.obj([612, 792, 0, 0]))],
    ["CROPOUTSIDE", (p) => p.setCropBox(-100, -100, 2000, 2000)],
  ];
  for (const [label, fn] of cases) {
    const p = doc.addPage([612, 792]);
    p.drawText(`${label} case`, { x: 160, y: 500, size: 16, font });
    fn(p);
  }
  // Inherited Rotate and MediaBox from the page tree node.
  const pagesNode = doc.catalog.Pages();
  const inherit = doc.addPage([612, 792]);
  inherit.drawText("INHERITROT case", { x: 160, y: 500, size: 16, font });
  inherit.node.delete(PDFName.of("MediaBox"));
  pagesNode.set(PDFName.of("Rotate"), PDFNumber.of(180));
  pagesNode.set(PDFName.of("MediaBox"), doc.context.obj([0, 0, 612, 792]));
  // Leaf pages that set their own Rotate keep it; the ones above without it now inherit 180.
  await put("odd-boxes.pdf", await doc.save(), { words: ["OFFSETMEDIA", "ROT90", "INHERITROT", "CROPSMALL"] });
}

// ── Images: one fixture per kind, each drawn full page.
function photoRGB(w, h) {
  const d = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 3;
    d[i] = (128 + 100 * Math.sin(x / 37) * Math.cos(y / 23)) & 255;
    d[i + 1] = (x * 255 / w) & 255;
    d[i + 2] = (y * 255 / h) & 255;
  }
  return d;
}
async function imagePdf(label, imgDict, data, { drawW = 540, drawH = 405, extraObjs = [] } = {}) {
  const objs = [
    [1, "<< /Type /Catalog /Pages 2 0 R >>"],
    [2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>"],
    [3, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> /XObject << /Im1 6 0 R >> >> >>"],
    [4, stream("", `q ${drawW} 0 0 ${drawH} 36 300 cm /Im1 Do Q ` + text(`${label} image page`, 72, 740))],
    [5, helv],
    [6, Buffer.concat([B(`<< /Type /XObject /Subtype /Image ${imgDict} /Length ${data.length} >>\nstream\n`), data, B("\nendstream")])],
    ...extraObjs,
  ];
  return raw(objs).bytes;
}
const W = 1200, H = 900;
const rgbPx = photoRGB(W, H);
if (want("img-cmyk-jpeg.pdf")) {
  const jpg = await sharp(rgbPx, { raw: { width: W, height: H, channels: 3 } }).toColourspace("cmyk").jpeg({ quality: 90 }).toBuffer();
  await put("img-cmyk-jpeg.pdf", await imagePdf("CMYKJPEG", `/Width ${W} /Height ${H} /ColorSpace /DeviceCMYK /BitsPerComponent 8 /Filter /DCTDecode /Decode [1 0 1 0 1 0 1 0]`, jpg), { words: ["CMYKJPEG"], image: true });
}
if (want("img-cmyk-flate.pdf")) {
  const cmyk = Buffer.alloc(W * H * 4);
  for (let i = 0; i < W * H; i++) { cmyk[i * 4] = 255 - rgbPx[i * 3]; cmyk[i * 4 + 1] = 255 - rgbPx[i * 3 + 1]; cmyk[i * 4 + 2] = 255 - rgbPx[i * 3 + 2]; cmyk[i * 4 + 3] = 20; }
  await put("img-cmyk-flate.pdf", await imagePdf("CMYKFLATE", `/Width ${W} /Height ${H} /ColorSpace /DeviceCMYK /BitsPerComponent 8 /Filter /FlateDecode`, zlib.deflateSync(cmyk)), { words: ["CMYKFLATE"], image: true });
}
if (want("img-icc-rgb.pdf")) {
  const icc = Buffer.from(srgbProfile());
  await put("img-icc-rgb.pdf", await imagePdf("ICCRGB", `/Width ${W} /Height ${H} /ColorSpace [/ICCBased 7 0 R] /BitsPerComponent 8 /Filter /FlateDecode`, zlib.deflateSync(rgbPx), { extraObjs: [[7, stream("/N 3", icc, "flate")]] }), { words: ["ICCRGB"], image: true });
}
if (want("img-indexed.pdf")) {
  const idx = Buffer.alloc(W * H);
  for (let i = 0; i < W * H; i++) idx[i] = ((i % W) >> 6 ^ Math.floor(i / W) >> 6) & 3;
  await put("img-indexed.pdf", await imagePdf("INDEXED", `/Width ${W} /Height ${H} /ColorSpace [/Indexed /DeviceRGB 3 <FF0000 00FF00 0000FF FFFF00>] /BitsPerComponent 8 /Filter /FlateDecode`, zlib.deflateSync(idx)), { words: ["INDEXED"], image: true });
}
if (want("img-16bit.pdf")) {
  const d16 = Buffer.alloc(W * H * 6);
  for (let i = 0; i < W * H * 3; i++) d16.writeUInt16BE(rgbPx[i] * 257, i * 2);
  await put("img-16bit.pdf", await imagePdf("SIXTEENBIT", `/Width ${W} /Height ${H} /ColorSpace /DeviceRGB /BitsPerComponent 16 /Filter /FlateDecode`, zlib.deflateSync(d16)), { words: ["SIXTEENBIT"], image: true });
}
if (want("img-lab.pdf")) {
  await put("img-lab.pdf", await imagePdf("LABIMAGE", `/Width ${W} /Height ${H} /ColorSpace [/Lab << /WhitePoint [0.9505 1 1.089] /Range [-100 100 -100 100] >>] /BitsPerComponent 8 /Filter /FlateDecode`, zlib.deflateSync(rgbPx)), { words: ["LABIMAGE"], image: true });
}
if (want("img-smask.pdf")) {
  const alpha = Buffer.alloc(W * H);
  for (let i = 0; i < W * H; i++) alpha[i] = (i % W) * 255 / W;
  await put("img-smask.pdf", await imagePdf("SMASKED", `/Width ${W} /Height ${H} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /SMask 7 0 R`, zlib.deflateSync(rgbPx), {
    extraObjs: [[7, stream(`/Type /XObject /Subtype /Image /Width ${W} /Height ${H} /ColorSpace /DeviceGray /BitsPerComponent 8`, alpha, "flate")]],
  }), { words: ["SMASKED"], image: true });
}
if (want("img-indirect-dims.pdf")) {
  // Width and Height as indirect references: legal, and a classic parser trap.
  await put("img-indirect-dims.pdf", await imagePdf("INDIRECTDIMS", `/Width 7 0 R /Height 8 0 R /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode`, zlib.deflateSync(rgbPx), { extraObjs: [[7, String(W)], [8, String(H)]] }), { words: ["INDIRECTDIMS"], image: true });
}
// Minimal JPEG 2000 codestream: one tile, one component, no wavelet levels, an empty packet (mid-grey).
function j2k(w, h) {
  const u16 = (v) => { const b = Buffer.alloc(2); b.writeUInt16BE(v); return b; };
  const u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32BE(v); return b; };
  const siz = Buffer.concat([B("\xff\x51"), u16(41), u16(0), u32(w), u32(h), u32(0), u32(0), u32(w), u32(h), u32(0), u32(0), u16(1), Buffer.from([7, 1, 1])]);
  const cod = Buffer.concat([B("\xff\x52"), u16(12), Buffer.from([0, 0]), u16(1), Buffer.from([0, 0, 4, 4, 0, 1])]);
  const qcd = Buffer.concat([B("\xff\x5c"), u16(4), Buffer.from([0x40, 0x48])]);
  const body = Buffer.from([0x00]);
  const sot = Buffer.concat([B("\xff\x90"), u16(10), u16(0), u32(12 + 2 + body.length), Buffer.from([0, 1])]);
  return Buffer.concat([B("\xff\x4f"), siz, cod, qcd, sot, B("\xff\x93"), body, B("\xff\xd9")]);
}
if (want("img-jpx.pdf")) await put("img-jpx.pdf", await imagePdf("JPXIMAGE", `/Width 256 /Height 256 /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /JPXDecode`, j2k(256, 256)), { words: ["JPXIMAGE"], image: true });

// Text rendered to a bilevel bitmap and encoded as CCITT G4, and the same
// MMR data wrapped as an embedded JBIG2 generic region.
async function g4(w, h) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="white"/><text x="40" y="200" font-size="140" font-family="Arial" fill="black">SCAN G4 4471</text><rect x="40" y="300" width="${w - 80}" height="40" fill="black"/></svg>`;
  const { data } = await sharp(Buffer.from(svg)).greyscale().raw().toBuffer({ resolveWithObject: true });
  const rows = [];
  for (let y = 0; y < h; y++) {
    const r = new Array(w);
    for (let x = 0; x < w; x++) r[x] = data[y * w + x] < 128;
    rows.push(r);
  }
  return { data: Buffer.from(encodeG4(rows, w)), rows: h };
}
if (want("img-ccitt.pdf") || want("img-jbig2.pdf")) {
  const GW = 1600, GH = 400;
  const g = await g4(GW, GH);
  if (want("img-ccitt.pdf")) await put("img-ccitt.pdf", await imagePdf("CCITTIMG", `/Width ${GW} /Height ${g.rows} /ColorSpace /DeviceGray /BitsPerComponent 1 /Filter /CCITTFaxDecode /DecodeParms << /K -1 /Columns ${GW} /Rows ${g.rows} /BlackIs1 false >>`, g.data, { drawW: 540, drawH: 540 * g.rows / GW }), { words: ["CCITTIMG"], image: true });
  if (want("img-jbig2.pdf")) {
    const u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32BE(v); return b; };
    const seg = (num, type, data) => Buffer.concat([u32(num), Buffer.from([type, 0x00, 1]), u32(data.length), data]);
    const pageInfo = Buffer.concat([u32(GW), u32(g.rows), u32(0), u32(0), Buffer.from([0x00]), Buffer.from([0, 0])]);
    const region = Buffer.concat([u32(GW), u32(g.rows), u32(0), u32(0), Buffer.from([0x00]), Buffer.from([0x01]), g.data]);
    const jb2 = Buffer.concat([seg(0, 48, pageInfo), seg(1, 38, region), seg(2, 49, Buffer.alloc(0))]);
    await put("img-jbig2.pdf", await imagePdf("JBIGTWO", `/Width ${GW} /Height ${g.rows} /ColorSpace /DeviceGray /BitsPerComponent 1 /Filter /JBIG2Decode`, jb2, { drawW: 540, drawH: 540 * g.rows / GW }), { words: ["JBIGTWO"], image: true });
  }
}

// ── Bombs: tiny files with huge decoded size.
async function deflateZeros(total) {
  return new Promise((resolve, reject) => {
    const z = zlib.createDeflate({ level: 9 });
    const chunks = [];
    z.on("data", (c) => chunks.push(c));
    z.on("end", () => resolve(Buffer.concat(chunks)));
    z.on("error", reject);
    const block = Buffer.alloc(16 * 1024 * 1024);
    let left = total;
    const pump = () => {
      while (left > 0) {
        const n = Math.min(left, block.length);
        left -= n;
        if (!z.write(n === block.length ? block : block.subarray(0, n))) return z.once("drain", pump);
      }
      z.end();
    };
    pump();
  });
}
if (want("bomb-orphan.pdf")) {
  const z = await deflateZeros(1024 * 1024 * 1024);
  await put("bomb-orphan.pdf", raw([
    [1, "<< /Type /Catalog /Pages 2 0 R >>"],
    [2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>"],
    [3, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>"],
    [4, stream("", text("BOMBORPHAN small page"))],
    [5, helv],
    [6, Buffer.concat([B(`<< /Filter /FlateDecode /Length ${z.length} >>\nstream\n`), z, B("\nendstream")])],
  ]).bytes, { words: ["BOMBORPHAN"], inflated: "1 GiB orphan stream" });
}
if (want("bomb-image.pdf")) {
  const IW = 20000, IH = 20000;
  const z = await deflateZeros(IW * IH);
  await put("bomb-image.pdf", await imagePdf("BOMBIMAGE", `/Width ${IW} /Height ${IH} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode`, z), { words: ["BOMBIMAGE"], inflated: "400 MB gray image" });
}

// ── qpdf-made variants: object streams and every encryption flavour.
const qp = async (input, args) => (await runQpdf(new Uint8Array(input), (i, o) => [...args(i, o)])).output;
const baseBytes = await base();
if (want("objstm.pdf")) await put("objstm.pdf", await qp(plainBase, (i, o) => ["--object-streams=generate", "--compress-streams=y", i, o]), { words: ["ALPHA1", "ALPHA3"], secret: "SECRET1-4471" });
const enc = [
  ["enc-rc4-40-owner.pdf", ["--allow-weak-crypto", "--encrypt", "", "ownerpw", "40", "--print=n", "--modify=n", "--extract=n", "--annotate=n", "--"], ""],
  ["enc-rc4-128-user.pdf", ["--allow-weak-crypto", "--encrypt", "userpw", "ownerpw", "128", "--use-aes=n", "--"], "userpw"],
  ["enc-aes128-user.pdf", ["--encrypt", "userpw", "ownerpw", "128", "--use-aes=y", "--"], "userpw"],
  ["enc-aes256-owner.pdf", ["--encrypt", "", "ownerpw", "256", "--print=none", "--modify=none", "--extract=n", "--"], ""],
  ["enc-aes256-user.pdf", ["--encrypt", "userpw", "ownerpw", "256", "--"], "userpw"],
  ["enc-aes256-unicode-user.pdf", ["--encrypt", "pässwörd密码", "ownerpw", "256", "--"], "pässwörd密码"],
];
for (const [name, args, password] of enc) {
  if (!want(name)) continue;
  await put(name, await qp(baseBytes, (i, o) => [...args, i, o]), { password, words: ["ALPHA1", "ALPHA3"], secret: "SECRET1-4471", encrypted: true });
}

// ── The repo's own scan, as is and turned with an offset crop box.
const scanned = readFileSync(join(ROOT, "tests/fixtures/scanned.pdf"));
if (want("scanned.pdf")) await put("scanned.pdf", scanned, { scan: true });
if (want("scanned-rot90.pdf")) {
  const d = await PDFDocument.load(scanned);
  const p = d.getPage(0);
  const mb = p.getMediaBox();
  p.setMediaBox(mb.x - 50, mb.y - 30, mb.width + 100, mb.height + 60);
  p.setCropBox(mb.x, mb.y, mb.width, mb.height);
  p.setRotation(degrees(90));
  await put("scanned-rot90.pdf", await d.save(), { scan: true });
}

// A normal scanned page followed by a 200x200 in scanned page (large-format plan or poster).
if (want("huge-scan.pdf")) {
  const src = await PDFDocument.load(scanned);
  const d = await PDFDocument.create();
  const [emb] = await d.embedPdf(await src.save());
  d.addPage([612, 792]).drawPage(emb, { x: 0, y: 0, width: 612, height: 792 });
  d.addPage([14400, 14400]).drawPage(emb, { x: 0, y: 0, width: 14400, height: 14400 });
  await put("huge-scan.pdf", await d.save(), { scan: true });
}

// ── Linked pages: a contents page linking to every chapter, each chapter
// linking back and carrying its own photo. A one-page part of it must not
// carry the other pages along (they'd be invisible but still in the file).
if (want("book-links.pdf")) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const ctx = doc.context;
  const toc = doc.addPage([612, 792]);
  toc.drawText("CONTENTS of the book", { x: 72, y: 740, size: 20, font });
  const chapters = [];
  for (let i = 1; i <= 20; i++) {
    const p = doc.addPage([612, 792]);
    p.drawText(`CHAPTER${i} heading`, { x: 72, y: 740, size: 20, font });
    // A distinct noisy 120×120 photo per page, so it barely compresses.
    const px = Buffer.alloc(120 * 120 * 3);
    let seed = i * 7919;
    for (let k = 0; k < px.length; k++) px[k] = (seed = (seed * 1103515245 + 12345) & 0x7fffffff) >> 16;
    p.node.setXObject(PDFName.of("Im1"), ctx.register(ctx.flateStream(px, { Type: "XObject", Subtype: "Image", Width: 120, Height: 120, ColorSpace: "DeviceRGB", BitsPerComponent: 8 })));
    const ops = ctx.stream("q 240 0 0 240 72 400 cm /Im1 Do Q");
    p.node.addContentStream(ctx.register(ops));
    chapters.push(p);
  }
  toc.node.set(PDFName.of("Annots"), ctx.obj(chapters.map((p, i) => ctx.register(ctx.obj({ Type: "Annot", Subtype: "Link", Rect: [72, 700 - i * 12, 300, 710 - i * 12], Border: [0, 0, 0], Dest: [p.ref, PDFName.of("Fit")] })))));
  for (const p of chapters) p.node.set(PDFName.of("Annots"), ctx.obj([ctx.register(ctx.obj({ Type: "Annot", Subtype: "Link", Rect: [72, 60, 200, 80], Border: [0, 0, 0], Dest: [toc.ref, PDFName.of("Fit")] }))]));
  await put("book-links.pdf", await doc.save(), { words: ["CONTENTS", "CHAPTER1", "CHAPTER20"], imagesPerPage: 1 });
}

// A link whose web address repeats the secret on its line: redacting the
// line must take the link with it.
if (want("link-secret.pdf")) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const ctx = doc.context;
  const p1 = doc.addPage([612, 792]);
  const p2 = doc.addPage([612, 792]);
  p1.drawText("ALPHA1 statement for the client", { x: 72, y: 700, size: 14, font });
  p1.drawText("SECRET1-4471 account number", { x: 72, y: 650, size: 14, font });
  p2.drawText("ALPHA2 second page", { x: 72, y: 700, size: 14, font });
  p1.node.set(PDFName.of("Annots"), ctx.obj([ctx.register(ctx.obj({ Type: "Annot", Subtype: "Link", Rect: [72, 645, 260, 662], Border: [0, 0, 0], A: { S: "URI", URI: PDFString.of("https://bank.example/acct/SECRET1-4471") } }))]));
  p2.node.set(PDFName.of("Annots"), ctx.obj([ctx.register(ctx.obj({ Type: "Annot", Subtype: "Link", Rect: [72, 60, 200, 80], Border: [0, 0, 0], Dest: [p1.ref, PDFName.of("Fit")] }))]));
  await put("link-secret.pdf", await doc.save(), { words: ["ALPHA1", "ALPHA2"], secret: "SECRET1-4471" });
}

writeFileSync(join(OUT, "manifest.json"), JSON.stringify(manifest, null, 1));
console.log(`\n${Object.keys(manifest).length} fixtures in ${OUT}`);
