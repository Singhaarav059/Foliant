// Split PDF: split by size in linear time, sizes in KB or MB, compression for
// parts still over the limit, split by bookmarks at a chosen level, and the
// default ranges a file of any length gets. Every part must hold only its
// own pages: a link names another page, and following it carried that page
// along as hidden content.
//
//   node tests/split.mjs
import {
  PDFDocument, PDFName, PDFString, PDFHexString, PDFNumber, PDFRawStream, StandardFonts, decodePDFRawStream,
  pushGraphicsState, popGraphicsState, concatTransformationMatrix, drawObject,
} from "pdf-lib";
import { load, check, eq } from "./lib/load.mjs";

const { split } = await load("organize");
// Missing before P1-05: its tests fail one by one instead of all at once.
const { defaultRanges, rangesPreview, sizeFromMb } = await load("split-plan").catch(() => ({}));
const results = { failed: 0 };
const checked = check(results);
// A test may return a line to print, such as its time.
const test = (name, fn) => checked(name, async () => {
  const detail = await fn();
  if (detail) console.log(`      ${detail}`);
});
const file = (bytes, name = "book.pdf") => new File([bytes], name, { type: "application/pdf" });
const open = async (blob) => {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return { bytes, doc: await PDFDocument.load(bytes) };
};
const opts = (o) => ({ splitMode: "ranges", ranges: "", every: 1, maxSize: 5, sizeUnit: "MB", mergeRanges: false, allowCompression: false, bookmarkLevel: 1, ...o });
const KB = 1024, MB = 1024 * 1024;

let seed = 1;
const noise = (n) => Uint8Array.from({ length: n }, () => ((seed = (Math.imul(seed, 1103515245) + 12345) | 0) >>> 16) & 0xff);
const image = (doc, side) => doc.context.register(doc.context.flateStream(noise(side * side * 3), { Type: "XObject", Subtype: "Image", Width: side, Height: side, ColorSpace: "DeviceRGB", BitsPerComponent: 8 }));
const draw = (page, name, img, x = 100, y = 200, s = 200) => {
  page.node.setXObject(PDFName.of(name), img);
  page.pushOperators(pushGraphicsState(), concatTransformationMatrix(s, 0, 0, s, x, y), drawObject(name), popGraphicsState());
};

// Every secret written anywhere in a file: decoded streams and strings.
function secrets(doc) {
  const parts = [];
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (obj instanceof PDFRawStream) {
      let data;
      try {
        data = decodePDFRawStream(obj).decode();
      } catch {
        data = obj.contents;
      }
      parts.push(Buffer.from(data).toString("latin1"));
    } else parts.push(obj.toString());
  }
  const raw = parts.join("\n");
  const all = raw + raw.replace(/<([0-9A-Fa-f\s]+)>/g, (_, h) => Buffer.from(h.replace(/\s/g, ""), "hex").toString("latin1"));
  return [...new Set(all.match(/SECRET-\d+/g) ?? [])].sort((a, b) => Number(a.slice(7)) - Number(b.slice(7)));
}
const images = (doc) => doc.context.enumerateIndirectObjects().filter(([, o]) => o instanceof PDFRawStream && o.dict.get(PDFName.of("Subtype")) === PDFName.of("Image")).length;

// Pages with a secret and a photo each, every page linked from page 1 and
// linking back to it, so a part that follows links carries the whole book.
async function linkedBook(n, side = 64) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const pages = Array.from({ length: n }, () => doc.addPage([400, 600]));
  pages.forEach((page, i) => {
    page.drawText(`SECRET-${i + 1}`, { x: 40, y: 560, size: 14, font });
    draw(page, "Im1", image(doc, side));
    if (i) page.node.set(PDFName.of("Annots"), doc.context.obj([doc.context.obj({ Type: "Annot", Subtype: "Link", Rect: [40, 20, 200, 40], Dest: [pages[0].ref, PDFName.of("Fit")] })]));
  });
  pages[0].node.set(PDFName.of("Annots"), doc.context.obj(pages.slice(1).map((p, i) => doc.context.obj({ Type: "Annot", Subtype: "Link", Rect: [40, 500 - i, 200, 501 - i], Dest: [p.ref, PDFName.of("Fit")] }))));
  return { doc, pages };
}

// Pages held in each part, 1-based, as "1-3,4-6".
const spans = async (parts) => {
  const out = [];
  for (const p of parts) {
    const { doc } = await open(p.blob);
    const s = secrets(doc).map((x) => Number(x.slice(7)));
    eq(s.length, doc.getPageCount(), `${p.name}: secrets for its ${doc.getPageCount()} pages`);
    eq(images(doc), doc.getPageCount(), `${p.name}: images`);
    out.push(s.length === 1 ? `${s[0]}` : `${s[0]}-${s[s.length - 1]}`);
  }
  return out.join();
};

// ── Size: 1,500 pages, each with a small photo of its own and one large
// picture every page shows. Saving the whole growing part for every page
// took 84 s; measuring each page once takes a second or two.
await test("split by size: 1,500 pages in under 5 s, every part 1 MB or less, shared images counted once", async () => {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const shared = image(doc, 300); // 270 KB, on every page
  for (let i = 0; i < 1500; i++) {
    const page = doc.addPage([300, 300]);
    page.drawText(`SECRET-${i + 1}`, { x: 20, y: 270, size: 10, font });
    draw(page, "Bg", shared, 0, 0, 300);
    draw(page, "Im1", image(doc, 24), 20, 20, 60); // 1.7 KB
  }
  const bytes = await doc.save();
  const started = performance.now();
  const parts = await Promise.race([
    split(file(bytes, "many.pdf"), opts({ splitMode: "size", maxSize: 1, sizeUnit: "MB" })),
    new Promise((_, reject) => setTimeout(() => reject(new Error("still running after 5 s")), 5000)),
  ]);
  const ms = performance.now() - started;
  if (ms > 5000) throw new Error(`took ${Math.round(ms)} ms`);
  let pages = 0;
  for (const p of parts) {
    const { bytes: b, doc: d } = await open(p.blob);
    if (b.length > MB) throw new Error(`${p.name} is ${b.length} bytes`);
    pages += d.getPageCount();
  }
  eq(pages, 1500, "pages over all parts");
  // Each part holds the 270 KB picture once and about 2 KB per page: some
  // 350 pages fit in 1 MB, so 5 parts. Counting the shared picture once per
  // page would make 500.
  if (parts.length > 6) throw new Error(`${parts.length} parts`);
  return `${Math.round(ms)} ms, ${parts.length} parts`;
});

await test("split by size in KB: every part 100 KB or less and holds only its own pages", async () => {
  const { doc } = await linkedBook(40);
  const bytes = await doc.save(); // 40 pages of about 12 KB
  const parts = await split(file(bytes), opts({ splitMode: "size", maxSize: 100, sizeUnit: "KB" }));
  for (const p of parts) if (p.blob.size > 100 * KB) throw new Error(`${p.name} is ${p.blob.size} bytes`);
  if (parts.length < 5 || parts.length > 7) throw new Error(`${parts.length} parts`);
  const s = await spans(parts);
  eq(s.split(",").length, parts.length, "parts");
  return s;
});

await test("split by size in MB: 1 MB holds the whole 40-page book", async () => {
  const { doc } = await linkedBook(40);
  const parts = await split(file(await doc.save()), opts({ splitMode: "size", maxSize: 1, sizeUnit: "MB" }));
  eq(parts.length, 1, "parts");
});

await test("the old maxMb option still works", async () => {
  const { doc } = await linkedBook(40);
  const parts = await split(file(await doc.save()), { splitMode: "size", ranges: "", every: 1, maxMb: 0.1, mergeRanges: false });
  for (const p of parts) if (p.blob.size > 0.1 * MB) throw new Error(`${p.name} is ${p.blob.size} bytes`);
  if (parts.length < 5) throw new Error(`${parts.length} parts`);
});

// One page with a photo larger than the limit on its own: it stays a part
// of its own, and with compression allowed it's made to fit.
await test("allow compression shrinks a part that is over the limit on its own", async () => {
  const doc = await PDFDocument.create();
  draw(doc.addPage([400, 400]), "Im1", image(doc, 500), 0, 0, 400); // 750 KB of noise
  draw(doc.addPage([400, 400]), "Im1", image(doc, 40), 0, 0, 400);
  const bytes = await doc.save();
  const plain = await split(file(bytes), opts({ splitMode: "size", maxSize: 400, sizeUnit: "KB" }));
  eq(plain.length, 2, "parts");
  if (plain[0].blob.size <= 400 * KB) throw new Error("the photo page fits without compression; the test proves nothing");
  const squeezed = await split(file(bytes), opts({ splitMode: "size", maxSize: 400, sizeUnit: "KB", allowCompression: true }));
  eq(squeezed.length, 2, "parts");
  for (const p of squeezed) if (p.blob.size > 400 * KB) throw new Error(`${p.name} is ${p.blob.size} bytes`);
  eq((await open(squeezed[0].blob)).doc.getPageCount(), 1, "pages");
  return `${Math.round(plain[0].blob.size / KB)} KB -> ${Math.round(squeezed[0].blob.size / KB)} KB`;
});

// ── Bookmarks. A cover, then two parts of chapters with sections:
//   page 1 cover (no bookmark)
//   page 2 Part I > Chapter 1      page 3 Section 1.1 (a named destination)
//   page 4 Chapter 2 (a GoTo action)
//   page 5 Part II > Chapter 3     page 6 (more of chapter 3)
//   page 7 Chapter 4: In/Out
async function outlined() {
  const { doc, pages } = await linkedBook(7);
  const ctx = doc.context;
  const root = ctx.nextRef();
  const make = (parent, items) => {
    const refs = items.map(() => ctx.nextRef());
    items.forEach((it, i) => {
      const dict = { Title: PDFHexString.fromText(it.title), Parent: parent, ...it.dest };
      if (i) dict.Prev = refs[i - 1];
      if (i < refs.length - 1) dict.Next = refs[i + 1];
      if (it.kids) {
        const sub = make(refs[i], it.kids);
        Object.assign(dict, { First: sub[0], Last: sub[sub.length - 1], Count: PDFNumber.of(it.kids.length) });
      }
      ctx.assign(refs[i], ctx.obj(dict));
    });
    return refs;
  };
  const at = (i) => ({ Dest: [pages[i].ref, PDFName.of("Fit")] });
  const top = make(root, [
    { title: "Part I", dest: at(1), kids: [
      { title: "Chapter 1", dest: at(1), kids: [{ title: "Section 1.1", dest: { Dest: PDFString.of("sec11") } }] },
      { title: "Chapter 2", dest: { A: ctx.obj({ S: "GoTo", D: [pages[3].ref, PDFName.of("XYZ"), null, null, null] }) } },
    ] },
    { title: "Part II", dest: at(4), kids: [
      { title: "Chapter 3", dest: at(4) },
      { title: "Chapter 4: In/Out", dest: at(6) },
    ] },
  ]);
  ctx.assign(root, ctx.obj({ Type: "Outlines", First: top[0], Last: top[1], Count: PDFNumber.of(2) }));
  doc.catalog.set(PDFName.of("Outlines"), root);
  doc.catalog.set(PDFName.of("Names"), ctx.obj({ Dests: ctx.obj({ Names: [PDFString.of("sec11"), ctx.obj([pages[2].ref, PDFName.of("Fit")])] }) }));
  return doc.save();
}

const outline = await outlined();
for (const [level, names, pages] of [
  [1, "outline-1.pdf,Part I.pdf,Part II.pdf", "1,2-4,5-7"],
  [2, "outline-1.pdf,Chapter 1.pdf,Chapter 2.pdf,Chapter 3.pdf,Chapter 4 In Out.pdf", "1,2-3,4,5-6,7"],
  [3, "outline-1.pdf,Chapter 1.pdf,Section 1.1.pdf,Chapter 2.pdf,Chapter 3.pdf,Chapter 4 In Out.pdf", "1,2,3,4,5-6,7"],
]) {
  await test(`split by bookmarks at level ${level}: one file per bookmark, named after it, holding only its pages`, async () => {
    const parts = await split(file(outline, "outline.pdf"), opts({ splitMode: "bookmarks", bookmarkLevel: level }));
    eq(parts.map((p) => p.name).join(), names, "names");
    eq(await spans(parts), pages, "pages");
  });
}

await test("split by bookmarks: three chapters give three files named after them", async () => {
  const { doc, pages } = await linkedBook(6);
  const ctx = doc.context;
  const root = ctx.nextRef();
  const refs = [0, 2, 4].map(() => ctx.nextRef());
  ["Intro", "Methods", "Results"].forEach((title, i) => ctx.assign(refs[i], ctx.obj({
    Title: PDFHexString.fromText(title), Parent: root, Dest: [pages[i * 2].ref, PDFName.of("Fit")],
    ...(i ? { Prev: refs[i - 1] } : {}), ...(i < 2 ? { Next: refs[i + 1] } : {}),
  })));
  ctx.assign(root, ctx.obj({ Type: "Outlines", First: refs[0], Last: refs[2], Count: PDFNumber.of(3) }));
  doc.catalog.set(PDFName.of("Outlines"), root);
  const parts = await split(file(await doc.save(), "paper.pdf"), opts({ splitMode: "bookmarks" }));
  eq(parts.map((p) => p.name).join(), "Intro.pdf,Methods.pdf,Results.pdf", "names");
  eq(await spans(parts), "1-2,3-4,5-6", "pages");
});

await test("split by bookmarks: two bookmarks with one title get different file names", async () => {
  const { doc, pages } = await linkedBook(2);
  const ctx = doc.context;
  const root = ctx.nextRef();
  const [a, b] = [ctx.nextRef(), ctx.nextRef()];
  ctx.assign(a, ctx.obj({ Title: PDFHexString.fromText("Notes"), Parent: root, Next: b, Dest: [pages[0].ref, PDFName.of("Fit")] }));
  ctx.assign(b, ctx.obj({ Title: PDFHexString.fromText("Notes"), Parent: root, Prev: a, Dest: [pages[1].ref, PDFName.of("Fit")] }));
  ctx.assign(root, ctx.obj({ Type: "Outlines", First: a, Last: b, Count: PDFNumber.of(2) }));
  doc.catalog.set(PDFName.of("Outlines"), root);
  const parts = await split(file(await doc.save()), opts({ splitMode: "bookmarks" }));
  eq(parts.map((p) => p.name).join(), "Notes.pdf,Notes (2).pdf", "names");
});

await test("split by bookmarks: a file without bookmarks is an error the user can read", async () => {
  const { doc } = await linkedBook(2);
  try {
    await split(file(await doc.save(), "plain.pdf"), opts({ splitMode: "bookmarks" }));
  } catch (e) {
    eq(e.code, "no_bookmarks", "code");
    return;
  }
  throw new Error("no error");
});

// ── Defaults that fit the file, and the preview line under the field.
await test("default ranges stay within the file", () => {
  eq(defaultRanges(1), "1", "1 page");
  eq(defaultRanges(2), "1, 2", "2 pages");
  eq(defaultRanges(3), "1-2, 3", "3 pages");
  eq(defaultRanges(10), "1-5, 6-10", "10 pages");
});

await test("the preview lists the files a split makes", () => {
  eq(rangesPreview({ splitMode: "ranges", ranges: "1-2, 3" }, 3)?.join(), "1-2,3", "ranges");
  eq(rangesPreview({ splitMode: "ranges", ranges: "1-2, 3-4" }, 3)?.join(), "1-2,3", "ranges past the end");
  eq(rangesPreview({ splitMode: "ranges", ranges: "1-2, 3", mergeRanges: true }, 3)?.join(), "1-3", "merged");
  eq(rangesPreview({ splitMode: "ranges", ranges: "9-12" }, 3)?.length, 0, "nothing in range");
  eq(rangesPreview({ splitMode: "every", every: 4 }, 10)?.join(), "1-4,5-8,9-10", "every 4");
  eq(rangesPreview({ splitMode: "size" }, 10), undefined, "size: unknown until it runs");
});

await test("a workflow saved with a limit in maxMb keeps it", () => {
  eq(JSON.stringify(sizeFromMb({ maxMb: 12 })), '{"maxSize":12,"sizeUnit":"MB"}', "old");
  eq(JSON.stringify(sizeFromMb({ maxMb: 12, maxSize: 300, sizeUnit: "KB" })), "{}", "new");
});

process.exit(results.failed ? 1 : 0);
