// Editing a PDF's own text (P1-15): src/lib/pdf/edit.ts lists the page's text
// objects through PDFium and rewrites the ones the user changed. Each case is
// a generated PDF (standard 14 fonts, embedded subsets, a simple TrueType
// font, CJK, a rotated page, a page in two content streams) and checks:
//   - pdf.js extracts the new text where the old text was;
//   - the old text is in no content stream of the file, reachable or not;
//   - the rest of the page and the other pages are unchanged;
//   - the font is kept when it has the glyphs, and a fallback is reported
//     when it hasn't.
// Then layer order for added items.
//
//   node tests/textedit.mjs
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, PDFName, PDFRawStream, StandardFonts, decodePDFRawStream, degrees, rgb } from "pdf-lib";
import { createRequire } from "node:module";
import { load, openPdf, check, eq, root, vendorDir } from "./lib/load.mjs";

const { createCanvas } = createRequire(join(root, "package.json"))("@napi-rs/canvas");

// Bundled fonts the browser fetches from /vendor are read from disk.
globalThis.fetch = async (url) => {
  const file = basename(String(url));
  return new Response(readFileSync(join(vendorDir, "fonts", file)));
};

const edit = await load("edit");
const { fixForPdfA } = await load("pdfa");
const results = { failed: 0 };
const test = check(results);

const asFile = (bytes, name = "in.pdf") => new File([bytes], name, { type: "application/pdf" });
const outBytes = async (out) => new Uint8Array(await out[0].blob.arrayBuffer());
const near = (a, b, what, tol = 0.6) => {
  if (Math.abs(a - b) > tol) throw new Error(`${what}: expected ${b}, got ${a}`);
};
const has = (hay, needle, what) => {
  if (!hay.includes(needle)) throw new Error(`${what}: no "${needle}" in "${hay}"`);
};
const hasNot = (hay, needle, what) => {
  if (hay.includes(needle)) throw new Error(`${what}: "${needle}" is still there`);
};

// pdf.js text items of a page (1-based), and the page's text joined.
async function items(bytes, n = 1) {
  const doc = await openPdf(bytes.slice());
  return (await (await doc.getPage(n)).getTextContent()).items.filter((i) => i.str.trim());
}
const joined = (list) => list.map((i) => i.str).join("");

// Every stream in the file that shows text, reachable or not, read by pdf.js
// as a page with each real page's resources. An old content stream left
// behind (orphaned, or in another revision of the page) shows up here.
async function allStreamText(bytes) {
  const doc = await PDFDocument.load(bytes);
  const pages = doc.getPages();
  const streams = doc.context.enumerateIndirectObjects().filter(([, o]) => {
    if (!(o instanceof PDFRawStream)) return false;
    try {
      return /\bBT\b/.test(Buffer.from(decodePDFRawStream(o).decode()).toString("latin1"));
    } catch {
      return false;
    }
  });
  let raw = "";
  for (const [ref, o] of streams) {
    raw += Buffer.from(decodePDFRawStream(o).decode()).toString("latin1");
    for (const p of pages) {
      const extra = doc.addPage([612, 792]);
      extra.node.set(PDFName.of("Contents"), ref);
      extra.node.set(PDFName.of("Resources"), p.node.Resources());
    }
  }
  const out = await doc.save();
  const pdf = await openPdf(out);
  let text = "";
  for (let i = pages.length + 1; i <= pdf.numPages; i++) text += (await (await pdf.getPage(i)).getTextContent()).items.map((x) => x.str).join("") + "\n";
  return { text, raw };
}

// The page drawn by pdf.js at 1 pixel per point, as RGBA.
async function render(bytes, n = 1) {
  const page = await (await openPdf(bytes.slice())).getPage(n);
  const viewport = page.getViewport({ scale: 1 });
  const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvas, canvasContext: ctx, viewport }).promise;
  return { w: canvas.width, h: canvas.height, data: ctx.getImageData(0, 0, canvas.width, canvas.height).data };
}

// Pixels that differ between two renders, outside `skip` (visual fractions):
// the rest of the page, paths and other text, must look the same.
async function changedOutside(a, b, skip, n = 1) {
  const [ra, rb] = [await render(a, n), await render(b, n)];
  if (ra.w !== rb.w || ra.h !== rb.h) return Infinity;
  const pad = 3;
  const x0 = skip.x * ra.w - pad, x1 = (skip.x + skip.w) * ra.w + pad, y0 = skip.y * ra.h - pad, y1 = (skip.y + skip.h) * ra.h + pad;
  let changed = 0;
  for (let y = 0; y < ra.h; y++) {
    for (let x = 0; x < ra.w; x++) {
      if (x >= x0 && x <= x1 && y >= y0 && y <= y1) continue;
      const i = (y * ra.w + x) * 4;
      if (Math.abs(ra.data[i] - rb.data[i]) + Math.abs(ra.data[i + 1] - rb.data[i + 1]) + Math.abs(ra.data[i + 2] - rb.data[i + 2]) > 24) changed++;
    }
  }
  return changed;
}

// The page's content, decoded, for checking another page is untouched.
async function pageContent(bytes, index) {
  const doc = await PDFDocument.load(bytes);
  const page = doc.getPages()[index];
  const c = page.node.Contents();
  const list = c && "asArray" in c ? c.asArray() : [page.node.get(PDFName.of("Contents"))];
  return list.map((r) => Buffer.from(decodePDFRawStream(doc.context.lookup(r)).decode()).toString("latin1")).join("\n");
}

// A text-edit item for the object whose text is `was` on `page`.
async function editOf(file, page, was, text, move) {
  const objs = await edit.listText(file, page);
  const o = objs.find((x) => x.text === was);
  if (!o) throw new Error(`no text object "${was}" on page ${page + 1}: ${objs.map((x) => JSON.stringify(x.text)).join(", ")}`);
  const box = o.box;
  return { id: `e${page}-${o.index}`, page, kind: "textEdit", x: box.x + (move?.[0] ?? 0), y: box.y + (move?.[1] ?? 0), w: box.w, h: box.h, text, source: { index: o.index, was, x: box.x, y: box.y } };
}

async function run(bytes, edits) {
  const out = await edit.editPdf(asFile(bytes), edits, "edited");
  return { bytes: await outBytes(out), note: out[0].note ?? "" };
}

const woff = (dir, file) => readFileSync(join(vendorDir, dir, file));

// ── Fixtures

// Standard 14 fonts, a filled rectangle, and a second page.
async function standard14() {
  const doc = await PDFDocument.create();
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const p = doc.addPage([612, 792]);
  p.drawRectangle({ x: 60, y: 600, width: 200, height: 30, color: rgb(0.9, 0.9, 0.2) });
  p.drawText("Revenue grew 12%", { x: 72, y: 700, size: 14, font: helv, color: rgb(0.8, 0.1, 0.1) });
  p.drawText("Costs fell", { x: 72, y: 650, size: 12, font: bold });
  const p2 = doc.addPage([612, 792]);
  p2.drawText("Appendix", { x: 72, y: 700, size: 14, font: helv });
  return doc.save();
}

// An embedded subset (pdf-lib embeds a Type 0 font, Identity-H, with only the glyphs used).
async function subset() {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const tinos = await doc.embedFont(woff("pdfa-fonts", "tinos-latin-400-normal.woff"), { subset: true });
  const p = doc.addPage([612, 792]);
  p.drawText("Revenue fell", { x: 72, y: 700, size: 16, font: tinos });
  p.drawText("Other line", { x: 72, y: 600, size: 16, font: tinos });
  return doc.save();
}

// A simple TrueType font with WinAnsiEncoding (what PDF/A conversion embeds for Helvetica).
async function simpleTrueType() {
  const doc = await PDFDocument.load(await (async () => {
    const d = await PDFDocument.create();
    const helv = await d.embedFont(StandardFonts.Helvetica);
    d.addPage([612, 792]).drawText("Revenue rose", { x: 72, y: 700, size: 14, font: helv });
    return d.save();
  })());
  await fixForPdfA(doc, "2b");
  return doc.save();
}

// CJK: a Noto Sans JP slice, subset, Identity-H.
async function cjk() {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const jp = await doc.embedFont(woff("fonts", "noto-sans-jp-114-400-normal.woff"), { subset: true });
  const p = doc.addPage([612, 792]);
  p.drawText("海山市店", { x: 72, y: 700, size: 20, font: jp });
  p.drawText("安心", { x: 72, y: 600, size: 20, font: jp });
  return doc.save();
}

// /Rotate 90, with the text drawn turned so it reads upright on screen.
async function rotated() {
  const doc = await PDFDocument.create();
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const p = doc.addPage([612, 792]);
  p.setRotation(degrees(90));
  p.drawText("Revenue sideways", { x: 300, y: 100, size: 18, font: helv, rotate: degrees(90) });
  p.drawText("Keep me", { x: 400, y: 100, size: 18, font: helv, rotate: degrees(90) });
  return doc.save();
}

// Two content streams: the text to edit in the first, other text and a path in the second.
async function twoStreams() {
  const doc = await PDFDocument.create();
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const p = doc.addPage([612, 792]);
  p.drawText("Revenue first", { x: 72, y: 700, size: 14, font: helv });
  const ctx = doc.context;
  const first = p.node.Contents();
  // pdf-lib names the font it embedded; use the page's own name for it.
  const fname = p.node.Resources().lookup(PDFName.of("Font")).keys()[0];
  const fixed = ctx.register(ctx.flateStream(`q 0 0 1 rg 100 100 50 50 re f Q BT ${fname} 12 Tf 72 500 Td (Second stream) Tj ET`));
  p.node.set(PDFName.of("Contents"), ctx.obj([...(first.asArray ? first.asArray() : [first]), fixed]));
  return doc.save();
}

// ── Cases

await test("listText gives each text object with its text, font, size and a box on the page", async () => {
  const objs = await edit.listText(asFile(await standard14()), 0);
  const rev = objs.find((o) => o.text === "Revenue grew 12%");
  if (!rev) throw new Error(`objects: ${JSON.stringify(objs.map((o) => o.text))}`);
  eq(rev.font, "Helvetica", "font");
  near(rev.size, 14, "size", 0.01);
  // Visual fractions, top-left origin: x 72/612, baseline 700 → top near 1 - 710/792.
  near(rev.box.x, 72 / 612, "box x", 0.01);
  near(rev.box.y, 1 - 711 / 792, "box y", 0.01);
  eq(objs.some((o) => o.text === "Costs fell"), true, "other line listed");
});

await test("standard 14: replacing text keeps Helvetica, puts the new text in place and leaves no old text", async () => {
  const src = await standard14();
  const file = asFile(src);
  const before = await items(src);
  const { bytes, note } = await run(src, [await editOf(file, 0, "Revenue grew 12%", "Income grew 12%")]);
  const after = await items(bytes);
  const inc = after.find((i) => i.str === "Income grew 12%");
  if (!inc) throw new Error(`text: ${JSON.stringify(after.map((i) => i.str))}`);
  const old = before.find((i) => i.str === "Revenue grew 12%");
  near(inc.transform[4], old.transform[4], "x");
  near(inc.transform[5], old.transform[5], "y");
  near(inc.transform[0], 14, "size", 0.01);
  const { text, raw } = await allStreamText(bytes);
  hasNot(text, "Revenue", "any content stream");
  hasNot(raw, "Revenue", "raw content");
  // Unrelated content.
  const costs = after.find((i) => i.str === "Costs fell"), costs0 = before.find((i) => i.str === "Costs fell");
  near(costs.transform[4], costs0.transform[4], "other x", 0.01);
  near(costs.transform[5], costs0.transform[5], "other y", 0.01);
  const box = (await edit.listText(file, 0)).find((o) => o.text === "Revenue grew 12%").box;
  eq(await changedOutside(src, bytes, { ...box, w: box.w * 1.2 }), 0, "pixels changed outside the edited text");
  eq(await pageContent(bytes, 1), await pageContent(src, 1), "page 2 content");
  eq(note.includes("textFallback"), false, "no fallback reported");
});

await test("standard 14: keeps the text colour", async () => {
  const src = await standard14();
  const { bytes } = await run(src, [await editOf(asFile(src), 0, "Revenue grew 12%", "Income")]);
  const content = await pageContent(bytes, 0);
  const fills = [...content.matchAll(/([\d.]+) ([\d.]+) ([\d.]+) rg[^\n]*?BT/g)].map((m) => m.slice(1, 4).map(Number));
  if (!fills.some(([r, g, b]) => Math.abs(r - 0.8) < 0.01 && Math.abs(g - 0.1) < 0.01 && Math.abs(b - 0.1) < 0.01)) throw new Error(`fill colour: ${JSON.stringify(fills)}`);
});

await test("standard 14: letters Helvetica can't encode fall back to Arimo, and that is reported", async () => {
  const src = await standard14();
  const { bytes, note } = await run(src, [await editOf(asFile(src), 0, "Revenue grew 12%", "Zürich Łódź")]);
  has(joined(await items(bytes)), "Zürich Łódź", "pdf.js text");
  const { text } = await allStreamText(bytes);
  hasNot(text, "Revenue", "any content stream");
  has(note, "textFallback", "note");
  has(note, "Helvetica → Arimo", "fallback font named");
  const after = await items(bytes);
  const before = await items(src);
  const first = after.find((i) => i.str.startsWith("Z"));
  near(first.transform[4], before.find((i) => i.str.startsWith("Revenue")).transform[4], "x");
  near(first.transform[5], before.find((i) => i.str.startsWith("Revenue")).transform[5], "y");
  // The Bold line is still Helvetica-Bold and where it was.
  eq(await pageContent(bytes, 1), await pageContent(src, 1), "page 2 content");
});

await test("embedded subset: text whose glyphs are in the subset keeps the font", async () => {
  const src = await subset();
  const { bytes, note } = await run(src, [await editOf(asFile(src), 0, "Revenue fell", "Rule fen")]);
  const after = await items(bytes);
  has(joined(after), "Rule fen", "pdf.js text");
  hasNot((await allStreamText(bytes)).text, "Revenue", "any content stream");
  eq(note.includes("textFallback"), false, "no fallback");
  // Still the same embedded font: one font descriptor, with its font file.
  const doc = await PDFDocument.load(bytes);
  const descriptors = doc.context.enumerateIndirectObjects().filter(([, o]) => o.get?.(PDFName.of("Type")) === PDFName.of("FontDescriptor"));
  eq(descriptors.length, 1, "font descriptors");
  eq(String(descriptors[0][1].get(PDFName.of("FontName"))).includes("Tinos"), true, "Tinos");
  has(joined(after), "Other line", "other line");
});

await test("embedded subset: missing glyphs fall back to the matching stand-in (Tinos), reported", async () => {
  const src = await subset();
  const before = await items(src);
  const { bytes, note } = await run(src, [await editOf(asFile(src), 0, "Revenue fell", "Income fell")]);
  const after = await items(bytes);
  has(joined(after), "Income fell", "pdf.js text");
  hasNot((await allStreamText(bytes)).text, "Revenue", "any content stream");
  has(note, "→ Tinos", "fallback reported");
  const first = after.find((i) => i.str.startsWith("I"));
  near(first.transform[4], before[0].transform[4], "x");
  near(first.transform[5], before[0].transform[5], "y");
  near(first.transform[0], 16, "size", 0.01);
  const other = after.find((i) => i.str === "Other line");
  near(other.transform[5], before.find((i) => i.str === "Other line").transform[5], "other y", 0.01);
});

await test("simple TrueType font: in-font text keeps it; text outside WinAnsi falls back", async () => {
  const src = await simpleTrueType();
  const kept = await run(src, [await editOf(asFile(src), 0, "Revenue rose", "Income rose")]);
  has(joined(await items(kept.bytes)), "Income rose", "kept text");
  eq(kept.note.includes("textFallback"), false, "kept: no fallback");
  hasNot((await allStreamText(kept.bytes)).text, "Revenue", "kept: any content stream");
  const fell = await run(src, [await editOf(asFile(src), 0, "Revenue rose", "Ωmega rose")]);
  has(joined(await items(fell.bytes)), "Ωmega rose", "fallback text");
  has(fell.note, "textFallback", "fallback reported");
  hasNot((await allStreamText(fell.bytes)).text, "Revenue", "fallback: any content stream");
});

await test("CJK: glyphs in the subset keep the font; others fall back to Noto Sans JP", async () => {
  const src = await cjk();
  const before = await items(src);
  const kept = await run(src, [await editOf(asFile(src), 0, "海山市店", "山海店")]);
  has(joined(await items(kept.bytes)), "山海店", "kept text");
  eq(kept.note.includes("textFallback"), false, "kept: no fallback");
  hasNot((await allStreamText(kept.bytes)).text, "海山市", "kept: any content stream");
  const fell = await run(src, [await editOf(asFile(src), 0, "海山市店", "東京店")]);
  const after = await items(fell.bytes);
  has(joined(after), "東京店", "fallback text");
  has(fell.note, "→ Noto Sans JP", "fallback reported");
  hasNot((await allStreamText(fell.bytes)).text, "海山市", "fallback: any content stream");
  const first = after.find((i) => i.str.startsWith("東"));
  near(first.transform[4], before[0].transform[4], "x");
  near(first.transform[5], before[0].transform[5], "y");
  has(joined(after), "安心", "other line");
});

await test("rotated page: the new text keeps the turned matrix and position", async () => {
  const src = await rotated();
  const file = asFile(src);
  const objs = await edit.listText(file, 0);
  const o = objs.find((x) => x.text === "Revenue sideways");
  // On screen the page is landscape and the text reads left to right.
  eq(Math.round(o.angle), 0, "visual angle");
  if (!(o.box.w > o.box.h)) throw new Error(`box not landscape: ${JSON.stringify(o.box)}`);
  const before = await items(src);
  const { bytes } = await run(src, [await editOf(file, 0, "Revenue sideways", "Income sideways")]);
  const after = await items(bytes);
  const inc = after.find((i) => i.str === "Income sideways");
  const old = before.find((i) => i.str === "Revenue sideways");
  for (let k = 0; k < 6; k++) near(inc.transform[k], old.transform[k], `transform[${k}]`);
  hasNot((await allStreamText(bytes)).text, "Revenue", "any content stream");
  const keep = after.find((i) => i.str === "Keep me"), keep0 = before.find((i) => i.str === "Keep me");
  near(keep.transform[4], keep0.transform[4], "other x", 0.01);
});

await test("rotated page: moving text on screen moves it the same way on the page", async () => {
  const src = await rotated();
  const file = asFile(src);
  const before = await items(src);
  // 0.1 of the visual width to the right. Visually the page is 792 wide; to
  // the right on screen is up the page's own y axis for /Rotate 90.
  const { bytes } = await run(src, [await editOf(file, 0, "Revenue sideways", "Revenue sideways", [0.1, 0])]);
  const old = before.find((i) => i.str === "Revenue sideways");
  const moved = (await items(bytes)).find((i) => i.str === "Revenue sideways");
  near(moved.transform[4], old.transform[4], "x");
  near(moved.transform[5], old.transform[5] + 79.2, "y");
});

await test("a page in two content streams: the other stream is unchanged", async () => {
  const src = await twoStreams();
  const before = await items(src);
  const { bytes } = await run(src, [await editOf(asFile(src), 0, "Revenue first", "Income first")]);
  const after = await items(bytes);
  has(joined(after), "Income first", "new text");
  has(joined(after), "Second stream", "other stream's text");
  const s = after.find((i) => i.str === "Second stream"), s0 = before.find((i) => i.str === "Second stream");
  near(s.transform[5], s0.transform[5], "other y", 0.01);
  const box = (await edit.listText(asFile(src), 0)).find((o) => o.text === "Revenue first").box;
  eq(await changedOutside(src, bytes, box), 0, "pixels changed outside the edited text");
  hasNot((await allStreamText(bytes)).text, "Revenue", "any content stream");
});

await test("a content stream shared with another page: that page keeps its text", async () => {
  const doc = await PDFDocument.create();
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const p1 = doc.addPage([612, 792]);
  p1.drawText("Revenue shared", { x: 72, y: 700, size: 14, font: helv });
  const p2 = doc.addPage([612, 792]);
  p2.node.set(PDFName.of("Contents"), p1.node.get(PDFName.of("Contents")));
  p2.node.set(PDFName.of("Resources"), p1.node.get(PDFName.of("Resources")));
  const src = await doc.save();
  const { bytes } = await run(src, [await editOf(asFile(src), 0, "Revenue shared", "Income shared")]);
  eq(joined(await items(bytes, 1)), "Income shared", "page 1");
  eq(joined(await items(bytes, 2)), "Revenue shared", "page 2");
});

await test("deleting text removes it from every stream", async () => {
  const src = await standard14();
  const { bytes } = await run(src, [await editOf(asFile(src), 0, "Revenue grew 12%", "")]);
  hasNot(joined(await items(bytes)), "Revenue", "pdf.js text");
  hasNot((await allStreamText(bytes)).text, "Revenue", "any content stream");
  has(joined(await items(bytes)), "Costs fell", "other line");
});

await test("text in a script that needs shaping is refused, not drawn wrong", async () => {
  const src = await standard14();
  const e = await editOf(asFile(src), 0, "Revenue grew 12%", "مرحبا");
  let err;
  try {
    await run(src, [e]);
  } catch (x) {
    err = x;
  }
  eq(err?.code, "text_edit_failed", "error code");
});

await test("an edit made against other text is refused", async () => {
  const src = await standard14();
  const e = await editOf(asFile(src), 0, "Revenue grew 12%", "Income");
  e.source.was = "Something else";
  let err;
  try {
    await run(src, [e]);
  } catch (x) {
    err = x;
  }
  eq(err?.code, "text_edit_failed", "error code");
});

await test("textFonts says whether new text keeps the font, before saving", async () => {
  const file = asFile(await subset());
  const objs = await edit.listText(file, 0);
  const o = objs.find((x) => x.text === "Revenue fell");
  eq(JSON.stringify(await edit.textFonts(file, 0, o.index, "Rule fen")), JSON.stringify({ kept: true, font: o.font }), "kept");
  const fb = await edit.textFonts(file, 0, o.index, "Income");
  eq(fb.kept, false, "not kept");
  eq(fb.fallback, "Tinos", "fallback");
  eq((await edit.textFonts(file, 0, o.index, "مرحبا")).unsupported, true, "unsupported script");
});

await test("text edits and added items go in one save", async () => {
  const src = await standard14();
  const e = await editOf(asFile(src), 0, "Revenue grew 12%", "Income grew 12%");
  const added = { id: "t", page: 0, kind: "text", x: 0.1, y: 0.5, w: 0.3, h: 0.04, text: "Added note", fontSize: 12 };
  const { bytes } = await run(src, [e, added]);
  const t = joined(await items(bytes));
  has(t, "Income grew 12%", "edited");
  has(t, "Added note", "added");
  hasNot((await allStreamText(bytes)).text, "Revenue", "any content stream");
});

// ── Layer order for added items

await test("moveLayer brings an item forward and sends it back among its page's items", async () => {
  const list = [
    { id: "a", page: 0 }, { id: "x", page: 1 }, { id: "b", page: 0 }, { id: "c", page: 0 },
  ];
  eq(edit.moveLayer(list, "a", 1).map((i) => i.id).join(), "b,x,a,c", "a forward");
  eq(edit.moveLayer(list, "c", -1).map((i) => i.id).join(), "a,x,c,b", "c back");
  eq(edit.moveLayer(list, "c", 1).map((i) => i.id).join(), "a,x,b,c", "top stays");
  eq(edit.moveLayer(list, "a", -1).map((i) => i.id).join(), "a,x,b,c", "bottom stays");
});

await test("an item sent back is drawn under the one it was above", async () => {
  const doc = await PDFDocument.create();
  doc.addPage([612, 792]);
  const src = await doc.save();
  const red = { id: "r", page: 0, kind: "rect", x: 0.1, y: 0.1, w: 0.3, h: 0.3, color: "#ff0000", fill: "#ff0000" };
  const blue = { id: "b", page: 0, kind: "rect", x: 0.2, y: 0.2, w: 0.3, h: 0.3, color: "#0000ff", fill: "#0000ff" };
  const order = async (list) => {
    const content = await pageContent(await run(src, list).then((r) => r.bytes), 0);
    return content.indexOf("1 0 0 rg") < content.indexOf("0 0 1 rg") ? "red,blue" : "blue,red";
  };
  eq(await order([red, blue]), "red,blue", "as added");
  eq(await order(edit.moveLayer([red, blue], "b", -1)), "blue,red", "blue sent back");
});

console.log(results.failed ? `\n${results.failed} failed` : "\nall passed");
process.exit(results.failed ? 1 : 0);
