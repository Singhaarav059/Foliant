// Redaction tests: the hidden text must be gone from every stream, every
// extraction path and every side channel (tags, form objects, links,
// bookmarks), while everything outside the boxes stays real and selectable.
//
//   node tests/redact.mjs
import {
  PDFDocument, PDFName, PDFString, PDFRawStream, PDFArray, PDFDict, StandardFonts, degrees, decodePDFRawStream,
  PDFOperator, PDFOperatorNames as Ops, pushGraphicsState, popGraphicsState, concatTransformationMatrix, drawObject,
} from "pdf-lib";
import { load, openPdf, check, eq } from "./lib/load.mjs";

const { redact } = await load("security");
const results = { failed: 0 };
const test = check(results);
const SECRET = "SECRET-4471";
const W = 400, H = 300;

async function build() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.setTitle(`Case ${SECRET}`);

  // Page 1: secret in a line of public text, an image under part of the box,
  // a link over the secret and one over public text.
  const p1 = doc.addPage([W, H]);
  p1.drawText(`Account ${SECRET} belongs to the client`, { x: 20, y: 250, size: 12, font });
  p1.drawText("Public paragraph stays readable", { x: 20, y: 60, size: 12, font });
  const px = new Uint8Array(100 * 50 * 3).fill(200);
  const img = doc.context.register(doc.context.flateStream(px, { Type: "XObject", Subtype: "Image", Width: 100, Height: 50, ColorSpace: "DeviceRGB", BitsPerComponent: 8 }));
  p1.node.setXObject(PDFName.of("Im1"), img);
  p1.pushOperators(pushGraphicsState(), concatTransformationMatrix(200, 0, 0, 100, 100, 120), drawObject("Im1"), popGraphicsState());
  const link = (rect, url) => doc.context.register(doc.context.obj({ Type: "Annot", Subtype: "Link", Rect: rect, Border: [0, 0, 0], A: { S: "URI", URI: PDFString.of(url) } }));
  p1.node.set(PDFName.of("Annots"), doc.context.obj([link([70, 245, 140, 262], "https://example.com/secret"), link([20, 55, 120, 72], "https://example.com/public")]));

  // Page 2: the secret only in tagged ActualText, over harmless visible text.
  const p2 = doc.addPage([W, H]);
  p2.pushOperators(PDFOperator.of(Ops.BeginMarkedContentSequence, [PDFName.of("Span"), doc.context.obj({ ActualText: PDFString.of(SECRET) })]));
  p2.drawText("XXXXXXXXXX", { x: 20, y: 250, size: 12, font });
  p2.pushOperators(PDFOperator.of(Ops.EndMarkedContent));
  p2.drawText("Tag page footer", { x: 20, y: 60, size: 12, font });

  // Page 3: the secret inside a form XObject (a stamped page).
  const inner = await PDFDocument.create();
  const ip = inner.addPage([W, H]);
  ip.drawText(`Stamp ${SECRET}`, { x: 20, y: 250, size: 12, font: await inner.embedFont(StandardFonts.Helvetica) });
  const [stamp] = await doc.embedPdf(await inner.save());
  const p3 = doc.addPage([W, H]);
  p3.drawPage(stamp);
  p3.drawText("Form page footer", { x: 20, y: 60, size: 12, font });

  // Page 4: rotated 90° for display.
  const p4 = doc.addPage([H, W]);
  p4.setRotation(degrees(90));
  p4.drawText(`Turned ${SECRET}`, { x: 250, y: 20, size: 12, font, rotate: degrees(90) });
  p4.drawText("Turned page footer", { x: 60, y: 20, size: 12, font, rotate: degrees(90) });

  // Page 5: untouched.
  doc.addPage([W, H]).drawText(`Unmarked page ${SECRET.toLowerCase()}`, { x: 20, y: 250, size: 12, font });

  // A bookmark that names the secret.
  const outline = doc.context.register(doc.context.obj({ Title: PDFString.of(SECRET), Parent: null, Dest: [doc.getPage(0).ref, PDFName.of("Fit")] }));
  doc.catalog.set(PDFName.of("Outlines"), doc.context.obj({ Type: "Outlines", First: outline, Last: outline, Count: 1 }));
  return doc.save();
}

// Boxes as the editor sends them: fractions of the page as seen, top-left origin.
const frac = (x0, top, x1, bottom, w = W, h = H) => ({ x: x0 / w, y: top / h, w: (x1 - x0) / w, h: (bottom - top) / h });
const marks = [
  { page: 0, rect: frac(68, 36, 148, 56) }, // around SECRET-4471 on line 1 (y 250 ⇒ 50 from the top)
  { page: 0, rect: frac(150, 110, 200, 160) }, // over part of the image
  { page: 1, rect: frac(15, 36, 120, 56) },
  { page: 2, rect: frac(15, 36, 140, 56) },
  // Page 4 is seen as 400×300 after the turn. Turned clockwise, user x becomes
  // distance from the visual top: the secret (x 250) is near the bottom, the footer (x 60) near the top.
  { page: 3, rect: frac(0, 120, 400, 300) },
];

const input = await build();
const [out] = await redact(new File([input], "case.pdf"), marks, { redactDpi: "150" });
const bytes = new Uint8Array(await out.blob.arrayBuffer());
const doc = await PDFDocument.load(bytes);
const pdf = await openPdf(bytes.slice());
const pageText = async (i) => (await (await pdf.getPage(i + 1)).getTextContent()).items.map((t) => t.str).join(" ");
const allText = (await Promise.all(Array.from({ length: pdf.numPages }, (_, i) => pageText(i)))).join(" | ");
console.log(`      text after: ${allText}`);

await test("secret gone from every stream, in any encoding", () => {
  const hex = [...SECRET].map((c) => c.charCodeAt(0).toString(16).padStart(2, "0")).join("");
  const raw = new TextDecoder("latin1").decode(bytes);
  const hits = [];
  if (raw.includes(SECRET)) hits.push("file");
  for (const [ref, o] of doc.context.enumerateIndirectObjects()) {
    if (!(o instanceof PDFRawStream)) continue;
    let s;
    try { s = new TextDecoder("latin1").decode(decodePDFRawStream(o).decode()); } catch { continue; }
    if (s.includes(SECRET) || s.toLowerCase().includes(hex) || s.includes("4471")) hits.push(String(ref));
  }
  eq(hits.join(","), "", "objects containing the secret");
});

await test("secret gone from extracted text, public text still real", () => {
  eq(/4471/.test(allText.replace("secret-4471", "")), false, "secret in text");
  for (const kept of ["Account", "belongs to the client", "Public paragraph stays readable", "Tag page footer", "Form page footer", "Turned page footer", "secret-4471"])
    eq(allText.includes(kept), true, `"${kept}" kept`);
});

await test("image pixels under the box blacked out, others untouched", () => {
  const [, img] = doc.context.enumerateIndirectObjects().find(([, o]) => o instanceof PDFRawStream && o.dict.get(PDFName.of("Subtype")) === PDFName.of("Image"));
  const w = img.dict.get(PDFName.of("Width")).asNumber();
  const raw = decodePDFRawStream(img).decode();
  // Image spans x 100–300, y 120–220 at 2 pt per pixel; the box covers x 150–200, y 140–190.
  const at = (x, y) => raw[(Math.round((220 - y) / 2) * w + Math.round((x - 100) / 2)) * 3];
  eq(at(175, 165), 0, "inside");
  eq(at(260, 165), 200, "outside");
});

await test("link over the secret removed, other link kept", () => {
  const annots = doc.getPage(0).node.lookup(PDFName.of("Annots"), PDFArray).asArray().map((r) => doc.context.lookup(r));
  const urls = annots.map((a) => a.lookup(PDFName.of("A"), PDFDict).lookup(PDFName.of("URI")).decodeText());
  eq(urls.join(","), "https://example.com/public", "links");
});

await test("pages stay vector (no page turned into an image)", () => {
  const images = doc.context.enumerateIndirectObjects().filter(([, o]) => o instanceof PDFRawStream && o.dict.get(PDFName.of("Subtype")) === PDFName.of("Image"));
  eq(images.length, 1, "images (only the original one)");
  eq(doc.getPage(3).getRotation().angle, 90, "rotation kept");
});

await test("bookmarks and metadata don't carry the secret", () => {
  eq(doc.catalog.get(PDFName.of("Outlines")), undefined, "outlines");
  eq(String(doc.getTitle()).includes("4471"), false, "title");
});

process.exit(results.failed ? 1 : 0);
