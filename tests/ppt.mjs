// PDF → PowerPoint tests: text keeps its own colour (white on a dark panel
// stays readable), each raster picture becomes its own movable picture, and
// a page with no vector art gets no background image.
//
//   node tests/ppt.mjs
import { createRequire } from "node:module";
import { join } from "node:path";
import { PDFDocument, PDFName, StandardFonts, rgb, grayscale, cmyk } from "pdf-lib";
import JSZip from "jszip";
import { load, openPdf, check, eq, nodeCanvas, root } from "./lib/load.mjs";

const { pdfToPpt } = await load("convert");
const results = { failed: 0 };
const test = check(results);
nodeCanvas();

const W = 720, H = 405, SIZE = 18;
const EMU = 12700; // per point

// A small PNG of one colour, for an embedded raster picture.
function png(r, g, b) {
  const { createCanvas } = createRequire(join(root, "package.json"))("@napi-rs/canvas");
  const c = createCanvas(40, 30);
  const ctx = c.getContext("2d");
  ctx.fillStyle = `rgb(${r},${g},${b})`;
  ctx.fillRect(0, 0, 40, 30);
  ctx.fillStyle = "#fff";
  ctx.fillRect(10, 10, 20, 10);
  return new Uint8Array(c.toBuffer("image/png"));
}

async function deck() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  // Slide 1: a dark panel with white text, text in grey and CMYK, two pictures.
  const p1 = doc.addPage([W, H]);
  p1.drawRectangle({ x: 0, y: H - 120, width: W, height: 120, color: rgb(0.08, 0.1, 0.2) });
  p1.drawText("White title", { x: 40, y: H - 70, size: SIZE * 2, font, color: rgb(1, 1, 1) });
  p1.drawText("Grey note", { x: 40, y: 200, size: SIZE, font, color: grayscale(0.5) });
  p1.drawText("Red CMYK", { x: 40, y: 160, size: SIZE, font, color: cmyk(0, 1, 1, 0) });
  p1.drawText("Black body", { x: 40, y: 120, size: SIZE, font, color: rgb(0, 0, 0) });
  const a = await doc.embedPng(png(200, 30, 30));
  const b = await doc.embedPng(png(30, 30, 200));
  p1.drawImage(a, { x: 400, y: 60, width: 120, height: 90 });
  p1.drawImage(b, { x: 560, y: 60, width: 120, height: 90 });
  // Slide 2: text and one picture only, no vector art. Two separate text
  // items on one baseline, a space's width apart. (pdf-lib's widths include
  // kerning, which it doesn't draw: add up the glyphs' own advances.)
  const adv = (t) => [...t].reduce((w, ch) => w + font.widthOfTextAtSize(ch, SIZE), 0);
  const p2 = doc.addPage([W, H]);
  p2.drawText("Hello", { x: 40, y: 300, size: SIZE, font });
  p2.drawText("World", { x: 40 + adv("Hello "), y: 300, size: SIZE, font });
  p2.drawImage(a, { x: 300, y: 100, width: 200, height: 150 });
  // A label and its value far apart on one line, and a line in two colours.
  p2.drawText("Revenue", { x: 40, y: 60, size: SIZE, font });
  p2.drawText("1,200", { x: 600, y: 60, size: SIZE, font });
  p2.drawText("Total:", { x: 40, y: 30, size: SIZE, font });
  p2.drawText("42", { x: 40 + adv("Total: "), y: 30, size: SIZE, font, color: rgb(0.8, 0, 0) });
  return new Uint8Array(await doc.save());
}

const bytes = await deck();
// Opening a file here first starts pdf.js's worker from the package, not from /vendor.
await openPdf(bytes.slice());
const [out] = await pdfToPpt(new File([bytes], "deck.pdf"), { pptText: true });
const zip = await JSZip.loadAsync(await out.blob.arrayBuffer());
const slide = async (n) => zip.file(`ppt/slides/slide${n}.xml`).async("string");
const s1 = await slide(1);
const s2 = await slide(2);

// Each text box: its words and the colours of its runs.
const boxes = (xml) => [...xml.matchAll(/<p:sp>[\s\S]*?<\/p:sp>/g)].map((m) => ({
  text: [...m[0].matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((t) => t[1]).join(""),
  colors: [...m[0].matchAll(/<a:rPr[^>]*>[\s\S]*?<a:srgbClr val="([0-9A-Fa-f]{6})"/g)].map((c) => c[1].toUpperCase()),
}));
const colorOf = (xml, text) => boxes(xml).find((b) => b.text.includes(text))?.colors[0];

await test("white text on a dark panel stays white (FFFFFF)", async () => {
  eq(colorOf(s1, "White title"), "FFFFFF", "title colour");
});

await test("grey (DeviceGray) and black text keep their colours", async () => {
  eq(colorOf(s1, "Grey note"), "808080", "grey");
  eq(colorOf(s1, "Black body"), "000000", "black");
});

await test("CMYK red text comes out red", async () => {
  const c = colorOf(s1, "Red CMYK") ?? "";
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(c.slice(i, i + 2), 16));
  eq(r > 200 && g < 80 && b < 80, true, `red-ish (got ${c})`);
});

const pics = (xml) => [...xml.matchAll(/<p:pic>[\s\S]*?<\/p:pic>/g)].map((m) => {
  const off = m[0].match(/<a:off x="(\d+)" y="(\d+)"\/>/);
  const ext = m[0].match(/<a:ext cx="(\d+)" cy="(\d+)"\/>/);
  return { x: off[1] / EMU, y: off[2] / EMU, w: ext[1] / EMU, h: ext[2] / EMU };
});

await test("each raster image is its own picture, where it was", async () => {
  const got = pics(s1).sort((p, q) => p.x - q.x);
  eq(got.length, 2, "pictures on slide 1");
  const near = (a, b) => Math.abs(a - b) < 2;
  eq(near(got[0].x, 400) && near(got[0].y, H - 150) && near(got[0].w, 120) && near(got[0].h, 90), true, `first at ${JSON.stringify(got[0])}`);
  eq(near(got[1].x, 560) && near(got[1].w, 120), true, `second at ${JSON.stringify(got[1])}`);
  eq(pics(s2).length, 1, "pictures on slide 2");
});

await test("vector art stays as the background; a page without any has none", async () => {
  eq(/<p:bg>[\s\S]*?<a:blip /.test(s1), true, "slide 1 background image");
  eq(/<p:bg>[\s\S]*?<a:blip /.test(s2), false, "slide 2 background image");
});

await test("separate text items a space apart join with a space", async () => {
  eq(boxes(s2).some((b) => b.text === "Hello World"), true, `boxes: ${JSON.stringify(boxes(s2).map((b) => b.text))}`);
});

await test("a line in two colours keeps both, in one box", async () => {
  const box = boxes(s2).find((b) => b.text.startsWith("Total"));
  eq(box?.text, "Total: 42", "text");
  eq(JSON.stringify(box?.colors), JSON.stringify(["000000", "CC0000"]), "colours");
});

await test("each paragraph has its properties once, before its runs", async () => {
  for (const [n, xml] of [[1, s1], [2, s2]]) eq(/<\/a:r><a:pPr/.test(xml), false, `slide ${n}`);
});

await test("words far apart on one line get boxes of their own", async () => {
  const texts = boxes(s2).map((b) => b.text);
  eq(texts.includes("Revenue") && texts.includes("1,200"), true, `boxes: ${JSON.stringify(texts)}`);
});

// The picture behind the slide, as pixels.
async function pixels(xml, n) {
  const id = xml.match(/<p:bg>[\s\S]*?r:embed="([^"]+)"/)[1];
  const rels = await zip.file(`ppt/slides/_rels/slide${n}.xml.rels`).async("string");
  const target = rels.match(new RegExp(`Id="${id}"[^>]*Target="([^"]+)"`))?.[1] ?? rels.match(new RegExp(`Target="([^"]+)"[^>]*Id="${id}"`))[1];
  const data = await zip.file(join("ppt/slides", target).replace(/\\/g, "/")).async("nodebuffer");
  const { createCanvas, loadImage } = createRequire(join(root, "package.json"))("@napi-rs/canvas");
  const img = await loadImage(data);
  const c = createCanvas(img.width, img.height);
  c.getContext("2d").drawImage(img, 0, 0);
  const k = img.width / W;
  return (x, y) => [...c.getContext("2d").getImageData(Math.round(x * k), Math.round(y * k), 1, 1).data.slice(0, 3)];
}

await test("pictures and text are left out of the background; the panel stays", async () => {
  const at = await pixels(s1, 1);
  const [r, g, b] = at(405, H - 145); // inside the first picture's red border
  eq(r > 235 && g > 235 && b > 235, true, `background under the picture is white (got ${[r, g, b]})`);
  const panel = at(300, 20);
  eq(panel.every((c) => c < 80), true, `dark panel kept (got ${panel})`);
});

await test("pptText off: one picture of the whole page per slide, no text boxes", async () => {
  const [flat] = await pdfToPpt(new File([bytes], "deck.pdf"), { pptText: false });
  const z = await JSZip.loadAsync(await flat.blob.arrayBuffer());
  const x = await z.file("ppt/slides/slide1.xml").async("string");
  eq(boxes(x).length, 0, "text boxes");
  eq(/<p:bg>[\s\S]*?<a:blip /.test(x), true, "background image");
});

await test("an image stamp annotation stays on the slide, where it was", async () => {
  // A /Stamp whose appearance draws a red picture: its box is in the
  // appearance's own space, so it is left in the background, not cropped
  // from the wrong place.
  const doc = await PDFDocument.create();
  const img = await doc.embedPng(png(200, 30, 30));
  const page = doc.addPage([W, H]);
  const ctx = doc.context;
  const form = ctx.register(ctx.stream("q 200 0 0 150 0 0 cm /Im1 Do Q", { Type: "XObject", Subtype: "Form", BBox: [0, 0, 200, 150], Resources: { XObject: { Im1: img.ref } } }));
  const annot = ctx.register(ctx.obj({ Type: "Annot", Subtype: "Stamp", Rect: [100, 100, 300, 250], F: 4, AP: { N: form } }));
  page.node.set(PDFName.of("Annots"), ctx.obj([annot]));
  const b = new Uint8Array(await doc.save());
  const [o] = await pdfToPpt(new File([b], "stamp.pdf"), { pptText: true });
  const z = await JSZip.loadAsync(await o.blob.arrayBuffer());
  const x = await z.file("ppt/slides/slide1.xml").async("string");
  const id = x.match(/<p:bg>[\s\S]*?r:embed="([^"]+)"/)?.[1];
  eq(Boolean(id), true, "background image");
  const rels = await z.file("ppt/slides/_rels/slide1.xml.rels").async("string");
  const target = rels.match(new RegExp(`Id="${id}"[^>]*Target="([^"]+)"`))[1];
  const { createCanvas, loadImage } = createRequire(join(root, "package.json"))("@napi-rs/canvas");
  const im = await loadImage(await z.file(join("ppt/slides", target).replace(/\\/g, "/")).async("nodebuffer"));
  const c = createCanvas(im.width, im.height);
  c.getContext("2d").drawImage(im, 0, 0);
  const k = im.width / W;
  const [r, g, bl] = c.getContext("2d").getImageData(Math.round(110 * k), Math.round((H - 240) * k), 1, 1).data;
  eq(r > 150 && g < 80 && bl < 80, true, `red stamp in the background (got ${[r, g, bl]})`);
});

await test("a picture wholly off the page gives no picture; no negative sizes", async () => {
  const doc = await PDFDocument.create();
  const img = await doc.embedPng(png(200, 30, 30));
  const page = doc.addPage([W, H]);
  page.drawImage(img, { x: -300, y: 100, width: 200, height: 150 });
  page.drawImage(img, { x: W + 50, y: 100, width: 200, height: 150 });
  page.drawImage(img, { x: 300, y: 100, width: 100, height: 75 });
  const b = new Uint8Array(await doc.save());
  const [o] = await pdfToPpt(new File([b], "off.pdf"), { pptText: true });
  const z = await JSZip.loadAsync(await o.blob.arrayBuffer());
  const x = await z.file("ppt/slides/slide1.xml").async("string");
  eq(/<a:ext c[xy]="-/.test(x), false, "negative extent in the XML");
  eq((x.match(/<p:pic>/g) ?? []).length, 1, "pictures");
});

// Enough of an XML checker for slide parts: tags nest, attribute values are
// quoted with no raw <, & or ", and text has no raw < or &.
function wellFormed(xml) {
  const entity = /&(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g;
  const attrs = String.raw`(?:\s+[\w:.-]+="[^"<&]*")*`;
  const tag = new RegExp(String.raw`<(/?)([\w:.-]+)(${attrs})\s*(/?)>`, "y");
  const src = xml.replace(/^<\?xml[^>]*\?>\s*/, "").replace(entity, "");
  const stack = [];
  let i = 0;
  while (i < src.length) {
    const lt = src.indexOf("<", i);
    const text = src.slice(i, lt < 0 ? src.length : lt);
    if (text.includes("&")) return `raw & in text at ${i}`;
    if (lt < 0) break;
    tag.lastIndex = lt;
    const m = tag.exec(src);
    if (!m) return `bad tag at ${lt}: ${src.slice(lt, lt + 80)}`;
    if (m[1]) { if (stack.pop() !== m[2]) return `mismatched </${m[2]}> at ${lt}`; }
    else if (!m[4]) stack.push(m[2]);
    i = tag.lastIndex;
  }
  return stack.length ? `unclosed <${stack.at(-1)}>` : "";
}

await test("font names with & and quotes still give well-formed slides", async () => {
  const doc = await PDFDocument.create();
  const page = doc.addPage([W, H]);
  const names = ["AT&T-Sans", 'Foo"Bar', "Less<More"];
  for (const [k, n] of names.entries()) {
    const f = await doc.embedFont(StandardFonts.Helvetica);
    page.drawText(`Line ${k}`, { x: 40, y: 300 - k * 40, size: SIZE, font: f });
    await doc.flush?.();
    doc.context.lookup(f.ref).set(PDFName.of("BaseFont"), PDFName.of(n));
  }
  const b = new Uint8Array(await doc.save());
  const [o] = await pdfToPpt(new File([b], "fonts.pdf"), { pptText: true });
  const z = await JSZip.loadAsync(await o.blob.arrayBuffer());
  for (const name of Object.keys(z.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))) {
    const x = await z.file(name).async("string");
    eq(wellFormed(x), "", name);
    eq(boxes(x).map((bx) => bx.text).join("|"), "Line 0|Line 1|Line 2", "text");
  }
});

await test("a picture half off the page is left out of the background", async () => {
  const doc = await PDFDocument.create();
  const img = await doc.embedPng(png(200, 30, 30));
  const page = doc.addPage([W, H]);
  page.drawRectangle({ x: 600, y: 20, width: 60, height: 40, color: rgb(0, 0, 0) }); // so there is a background
  page.drawImage(img, { x: -100, y: 100, width: 200, height: 150 });
  const b = new Uint8Array(await doc.save());
  const [o] = await pdfToPpt(new File([b], "half.pdf"), { pptText: true });
  const z = await JSZip.loadAsync(await o.blob.arrayBuffer());
  const x = await z.file("ppt/slides/slide1.xml").async("string");
  eq(pics(x).length, 1, "pictures");
  const id = x.match(/<p:bg>[\s\S]*?r:embed="([^"]+)"/)?.[1];
  eq(Boolean(id), true, "background image");
  const rels = await z.file("ppt/slides/_rels/slide1.xml.rels").async("string");
  const target = rels.match(new RegExp(`Id="${id}"[^>]*Target="([^"]+)"`))[1];
  const { createCanvas, loadImage } = createRequire(join(root, "package.json"))("@napi-rs/canvas");
  const im = await loadImage(await z.file(join("ppt/slides", target).replace(/\\/g, "/")).async("nodebuffer"));
  const c = createCanvas(im.width, im.height);
  c.getContext("2d").drawImage(im, 0, 0);
  const k = im.width / W;
  const px = [...c.getContext("2d").getImageData(Math.round(50 * k), Math.round((H - 200) * k), 1, 1).data.slice(0, 3)];
  eq(px.every((v) => v > 235), true, `background under the picture is white (got ${px})`);
});

process.exit(results.failed ? 1 : 0);
