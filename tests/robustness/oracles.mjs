// One engine on one fixture, judged by oracles: the reference reader (pdf.js)
// must open the output, page counts and words must survive, forms, fields,
// attachments and outlines must not be lost, redaction must remove what's
// inside the boxes (anywhere in the file) and keep what's outside, a part of
// a file must not carry the rest of it along, and compress must not grow the
// file. run.mjs adds the time and memory limits. Prints one RESULT line.
//
//   node tests/robustness/oracles.mjs <corpus-dir> <out-dir> <tool> <fixture> [variant]
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { load, refInfo, refOpen, fileOf, vendorDir, require } from "./env.mjs";

const [corpus, outRoot, tool, fixture, variant = ""] = process.argv.slice(2);
const manifest = JSON.parse(readFileSync(join(corpus, "manifest.json"), "utf8"));
const meta = manifest[fixture] ?? {};
const bytes = new Uint8Array(readFileSync(join(corpus, fixture)));
const outDir = join(outRoot, `${tool}${variant ? "-" + variant : ""}`, fixture.replace(/\.pdf$/, ""));
mkdirSync(outDir, { recursive: true });
const JSZip = (await import("jszip")).default;
const napi = require("@napi-rs/canvas");
const { PDFDocument, PDFName, PDFRawStream, decodePDFRawStream } = await import("pdf-lib");

const result = { tool, fixture, variant, ok: false, problems: [], info: {} };
const problem = (s) => result.problems.push(s);
const t0 = Date.now();

let refIn = null;
try { refIn = await refInfo(bytes, meta.password); } catch (e) { result.info.refInError = e.message.slice(0, 120); }
const words = meta.words ?? [];
const inputText = (refIn?.pages ?? []).map((p) => p.text).join(" ");

async function pdfSummary(blob, password) {
  const b = new Uint8Array(await blob.arrayBuffer());
  try {
    const r = await refInfo(b, password);
    return { ok: true, size: b.length, numPages: r.numPages, text: r.pages.map((p) => p.text).join(" "), pages: r.pages, attachments: r.attachments, fields: r.fields, outline: r.outline };
  } catch (e) {
    return { ok: false, size: b.length, error: `${e.name}: ${e.message}`.slice(0, 160) };
  }
}
const annotCount = (pages) => (pages ?? []).reduce((n, p) => n + p.annots.length, 0);
function checkWords(text, label, list = words) {
  // Only words the reference reader finds in the input; spacing between CJK runs is ignored.
  const squash = (x) => x.replace(/\s+/g, "");
  if (refIn) list = list.filter((w) => squash(inputText).includes(squash(w)));
  const missing = list.filter((w) => !squash(text).includes(squash(w)));
  if (missing.length) problem(`${label}: missing words ${JSON.stringify(missing)}`);
  if (meta.stale && text.includes(meta.stale)) problem(`${label}: shows stale/shadow content "${meta.stale}" that the reference reader does not show`);
}
async function savePdf(o, i = 0) {
  const b = new Uint8Array(await o.blob.arrayBuffer());
  writeFileSync(join(outDir, `${i}-${o.name.replace(/[\/\\]/g, "_")}`), b);
  return b;
}
// Same-shape checks for tools whose output should be the input, page for page.
async function samePages(out, label, { rotateBy = null, keepAnnots = true, keepExtras = true, password } = {}) {
  const s = await pdfSummary(out.blob, password);
  result.info.out = { size: s.size, numPages: s.numPages, note: out.note };
  if (!s.ok) return problem(`${label}: output unreadable by pdf.js (${s.error})`);
  if (refIn && s.numPages !== refIn.numPages) problem(`${label}: page count ${refIn.numPages} -> ${s.numPages}`);
  checkWords(s.text, label);
  if (refIn && keepAnnots) {
    const a = annotCount(refIn.pages), b = annotCount(s.pages);
    if (b < a) problem(`${label}: annotations on sampled pages ${a} -> ${b}`);
  }
  if (refIn && keepExtras) {
    if (s.attachments < refIn.attachments) problem(`${label}: attachments ${refIn.attachments} -> ${s.attachments}`);
    if (s.fields < refIn.fields) problem(`${label}: form fields ${refIn.fields} -> ${s.fields}`);
    if (s.outline < refIn.outline) problem(`${label}: outline items ${refIn.outline} -> ${s.outline}`);
  }
  if (refIn && rotateBy !== null) {
    const bad = s.pages.filter((p, k) => p.rotate !== (((refIn.pages[k]?.rotate ?? 0) + rotateBy) % 360 + 360) % 360);
    if (bad.length) problem(`${label}: rotation wrong on pages ${bad.map((p) => `${p.i}:${p.rotate}`).join(",")} (inputs ${bad.map((p) => refIn.pages.find((q) => q.i === p.i)?.rotate).join(",")})`);
  }
  return s;
}
async function zipText(blob, files) {
  const zip = await JSZip.loadAsync(await blob.arrayBuffer());
  let xml = "";
  for (const name of Object.keys(zip.files)) if (files.test(name)) xml += await zip.file(name).async("string");
  return xml.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ");
}
// What a file stores, visible or not: image XObjects, and every object's
// text (dictionaries, strings and decoded streams, including object streams).
async function stored(b) {
  const doc = await PDFDocument.load(b, { ignoreEncryption: true, updateMetadata: false });
  let images = 0, text = "";
  for (const [, o] of doc.context.enumerateIndirectObjects()) {
    if (o instanceof PDFRawStream) {
      if (o.dict.get(PDFName.of("Subtype")) === PDFName.of("Image")) { images++; continue; }
      text += String(o.dict);
      try { text += Buffer.from(decodePDFRawStream(o).decode()).toString("latin1"); } catch { /* undecodable filter */ }
    } else text += String(o);
  }
  return { images, text };
}
// A part of a file must not carry the rest along as hidden content: no more
// images than its pages show, and no more than its share of the input's size.
async function noHiddenPages(parts, label) {
  if (!meta.imagesPerPage || !refIn) return;
  let images = 0, size = 0, pages = 0;
  for (const part of parts) {
    const b = new Uint8Array(await part.blob.arrayBuffer());
    images += (await stored(b)).images;
    pages += (await PDFDocument.load(b, { updateMetadata: false })).getPageCount();
    size += b.length;
  }
  const share = (bytes.length * pages) / refIn.numPages;
  result.info.parts = { pages, images, size };
  if (images > pages * meta.imagesPerPage) problem(`${label}: ${pages} page(s) out store ${images} images, at most ${pages * meta.imagesPerPage} are shown`);
  if (size > 2 * share + 4096 * parts.length) problem(`${label}: ${size} bytes out for ${pages} of ${refIn.numPages} pages (${(size / share).toFixed(1)}x their share of the input)`);
}

try {
  const f = fileOf(bytes, variant === "colonname" ? "Q1: report [final]?.pdf" : fixture);
  switch (tool) {
    case "merge": {
      const { merge } = await load("organize");
      const [o] = await merge([f, fileOf(bytes, "second.pdf")], { bookmarks: true });
      await savePdf(o);
      const s = await pdfSummary(o.blob);
      result.info.out = { size: s.size, numPages: s.numPages };
      if (!s.ok) problem(`merge: output unreadable (${s.error})`);
      else {
        if (refIn && s.numPages !== refIn.numPages * 2) problem(`merge: pages ${refIn.numPages}x2 -> ${s.numPages}`);
        checkWords(s.text, "merge");
        if (refIn && s.attachments < refIn.attachments) problem(`merge: attachments ${refIn.attachments} -> ${s.attachments}`);
        if (refIn && s.fields < refIn.fields) problem(`merge: form fields ${refIn.fields} -> ${s.fields}`);
        const a = annotCount(refIn?.pages), b = annotCount(s.pages.filter((p) => p.i <= (refIn?.numPages ?? 0)));
        if (refIn && s.numPages <= 40 && b < a) problem(`merge: annotations on first copy ${a} -> ${b}`);
      }
      break;
    }
    case "split": {
      const { split } = await load("organize");
      const opts = variant === "size" ? { splitMode: "size", ranges: "", every: 1, maxMb: 1, mergeRanges: false }
        : variant === "ranges" ? { splitMode: "ranges", ranges: "1-2, 3-4", every: 1, maxMb: 5, mergeRanges: false }
        : variant === "bookmarks" ? { splitMode: "bookmarks", ranges: "", every: 1, maxMb: 5, mergeRanges: false, bookmarkLevel: 1 }
        : { splitMode: "every", ranges: "", every: 1, maxMb: 5, mergeRanges: false };
      const outs = await split(f, opts);
      let pages = 0, text = "", unreadable = 0;
      for (let i = 0; i < outs.length; i++) {
        if (i < 5) await savePdf(outs[i], i);
        const s = await pdfSummary(outs[i].blob);
        if (!s.ok) { unreadable++; continue; }
        pages += s.numPages;
        if (i < 50 || i > outs.length - 5) text += " " + s.text;
      }
      result.info.out = { files: outs.length, pages };
      if (unreadable) problem(`split: ${unreadable} unreadable parts`);
      if (refIn && variant !== "ranges" && pages !== refIn.numPages) problem(`split: pages ${refIn.numPages} -> ${pages} across ${outs.length} files`);
      if (variant !== "ranges") checkWords(text, "split", refIn && refIn.numPages > 50 ? words.slice(0, 1) : words);
      await noHiddenPages(outs, "split");
      break;
    }
    case "extract": {
      // Page 2 on its own (or page 1 of a one-page file).
      const { extractSeparate } = await load("organize");
      const page = refIn && refIn.numPages > 1 ? 1 : 0;
      const outs = await extractSeparate(f, [page]);
      await savePdf(outs[0]);
      const s = await pdfSummary(outs[0].blob);
      result.info.out = { size: s.size, numPages: s.numPages };
      if (!s.ok) problem(`extract: output unreadable (${s.error})`);
      else if (s.numPages !== 1) problem(`extract: ${s.numPages} pages, expected 1`);
      await noHiddenPages(outs, "extract");
      break;
    }
    case "organize": {
      // Keep only the first page, as removing every other page does.
      const { buildFromPlan } = await load("organize");
      const blob = await buildFromPlan([f], [{ file: 0, page: 0, rotate: 0 }]);
      await savePdf({ blob, name: "kept.pdf" });
      const s = await pdfSummary(blob);
      result.info.out = { size: s.size, numPages: s.numPages };
      if (!s.ok) problem(`organize: output unreadable (${s.error})`);
      else if (s.numPages !== 1) problem(`organize: ${s.numPages} pages, expected 1`);
      if (refIn?.pages[0] && s.ok) checkWords(s.text, "organize", words.filter((w) => refIn.pages[0].text.includes(w)));
      await noHiddenPages([{ blob }], "organize");
      break;
    }
    case "rotate": {
      const { rotateAll } = await load("organize");
      const [o] = await rotateAll(f, 90);
      await savePdf(o);
      await samePages(o, "rotate", { rotateBy: 90 });
      break;
    }
    case "compress": {
      const { compress } = await load("optimize");
      const [o] = await compress(f, { level: variant || "recommended" });
      await savePdf(o);
      await samePages(o, "compress");
      if (o.blob.size > bytes.length) problem(`compress: output ${o.blob.size} > input ${bytes.length}`);
      result.info.ratio = +(o.blob.size / bytes.length).toFixed(3);
      break;
    }
    case "watermark": {
      const { watermark } = await load("edit");
      const markText = variant === "hindi" ? "गोपनीय" : variant === "cjk" ? "机密文件" : "CONFIDENTIAL";
      const [o] = await watermark(f, { markType: "text", markText, fontSize: 56, color: "#d33f6a", imageScale: 40, position: "middle-center", mosaic: variant === "mosaic", opacity: 30, rotation: "45", layer: variant === "under" ? "under" : "over", pageRange: "" });
      await savePdf(o);
      const s = await samePages(o, "watermark");
      if (s?.ok) {
        const marked = s.pages.filter((p) => p.text.replace(/\s+/g, "").includes(markText.slice(0, 2))).length;
        if (marked < s.pages.length) problem(`watermark: mark text found on ${marked}/${s.pages.length} sampled pages`);
      }
      break;
    }
    case "pagenumbers": {
      const { pageNumbers } = await load("edit");
      const [o] = await pageNumbers(f, { position: "bottom-center", numberFormat: "pageNOfTotal", startAt: 1, pageRange: "", skipFirst: false, fontSize: 11, color: "#1f2937", facing: false });
      await savePdf(o);
      const s = await samePages(o, "pagenumbers");
      if (s?.ok) {
        const bad = s.pages.filter((p) => !p.text.includes(`Page ${p.i} of ${s.numPages}`));
        if (bad.length) problem(`pagenumbers: label missing on pages ${bad.map((p) => p.i).slice(0, 10).join(",")}`);
      }
      break;
    }
    case "ocr": {
      const ocrMod = await load("ocr");
      const { grayPng } = await load("ocrprep");
      // tesseract.js decides browser vs Node at import time from `document`; hide the canvas polyfill.
      const savedDoc = globalThis.document;
      delete globalThis.document;
      const { createWorker, createScheduler } = await import("tesseract.js");
      globalThis.document = savedDoc;
      // tesseract.js copies the language data (about 6 MB) into its cache. It
      // lives in this case's output folder and goes once the OCR is done (or
      // with the folder, if the case dies first).
      const cache = join(outDir, "tesseract-cache");
      mkdirSync(cache, { recursive: true });
      ocrMod.engine.create = async (lang, count) => {
        const scheduler = createScheduler();
        // tesseract.js takes the browser path when `document` exists; hide the canvas polyfill meanwhile.
        const saved = globalThis.document;
        delete globalThis.document;
        try {
          for (let i = 0; i < count; i++) scheduler.addWorker(await createWorker(lang, undefined, { langPath: join(vendorDir, "tessdata"), cachePath: cache }));
        } finally { globalThis.document = saved; }
        return {
          recognise: async (image) => (await scheduler.addJob("recognize", Buffer.from(grayPng(image)), {}, { blocks: true })).data,
          stop: () => scheduler.terminate(),
        };
      };
      const { ocr } = await load("optimize");
      let o;
      try {
        [o] = await ocr(f, { ocrLang: "eng", dpi: variant || "200", ocrEngine: "standard" });
      } finally {
        rmSync(cache, { recursive: true, force: true });
      }
      await savePdf(o);
      const s = await samePages(o, "ocr");
      result.info.note = o.note;
      if (s?.ok) result.info.ocrText = s.text.slice(0, 200);
      if (s?.ok && meta.scan && !/4471/.test(s.text)) problem(`ocr: scan text "4471" not recognised (got "${s.text.slice(0, 60)}")`);
      break;
    }
    case "word": {
      const { pdfToWord } = await load("convert");
      const [o] = await pdfToWord(f, { wordMode: variant || "editable" });
      writeFileSync(join(outDir, o.name), new Uint8Array(await o.blob.arrayBuffer()));
      const t = await zipText(o.blob, /^word\/(document|header\d*|footer\d*)\.xml$/);
      result.info.out = { size: o.blob.size, chars: t.length };
      // Header/footer numbers become live PAGE fields, so compare with digits removed.
      const nd = (x) => x.replace(/\d+/g, "");
      if (variant !== "exact") checkWords(nd(t), "word", (meta.words ?? []).filter((w) => inputText.includes(w)).map(nd));
      break;
    }
    case "excel": {
      const { pdfToExcel } = await load("convert");
      const [o] = await pdfToExcel(f, { sheetPer: variant === "colonname" ? "document" : "page" });
      writeFileSync(join(outDir, "out.xlsx"), new Uint8Array(await o.blob.arrayBuffer()));
      const t = await zipText(o.blob, /^xl\/(sharedStrings|worksheets\/sheet\d+)\.xml$/);
      result.info.out = { size: o.blob.size, chars: t.length };
      checkWords(t, "excel", (meta.words ?? []).filter((w) => inputText.includes(w)));
      break;
    }
    case "images": {
      const { pdfToImages } = await load("convert");
      const dpi = variant || "150";
      const outs = await pdfToImages(f, { dpi, format: "jpg" });
      result.info.out = { files: outs.length, bytes: outs.reduce((n, o) => n + o.blob.size, 0) };
      if (refIn && outs.length !== refIn.numPages) problem(`images: ${outs.length} images for ${refIn.numPages} pages`);
      for (let i = 0; i < Math.min(3, outs.length); i++) {
        const buf = Buffer.from(await outs[i].blob.arrayBuffer());
        writeFileSync(join(outDir, outs[i].name), buf);
        try {
          const img = await napi.loadImage(buf);
          const p = refIn?.pages[i];
          if (p) {
            const [x0, y0, x1, y1] = p.view;
            let w = Math.abs(x1 - x0) * Number(dpi) / 72, h = Math.abs(y1 - y0) * Number(dpi) / 72;
            if (p.rotate % 180) [w, h] = [h, w];
            if (Math.abs(img.width - w) > 2 || Math.abs(img.height - h) > 2) problem(`images: page ${i + 1} is ${img.width}x${img.height}, expected ~${Math.round(w)}x${Math.round(h)}`);
          }
          (result.info.dims ??= []).push(`${img.width}x${img.height}`);
        } catch (e) { problem(`images: image ${i + 1} undecodable (${e.message})`); }
      }
      break;
    }
    case "redact": {
      const { redact } = await load("security");
      // Where pdf.js (the editor's renderer) shows a text item, as fractions of the page.
      const frame = (it, vp) => {
        const [a, b, , , e, f2] = it.transform;
        const len = Math.hypot(a, b) || 1;
        const ux = a / len, uy = b / len;
        const corners = [[e, f2], [e + ux * it.width, f2 + uy * it.width], [e - uy * it.height, f2 + ux * it.height], [e + ux * it.width - uy * it.height, f2 + uy * it.width + ux * it.height]]
          .map(([x, y]) => vp.convertToViewportPoint(x, y)).map(([x, y]) => [x / vp.width, y / vp.height]);
        const xs = corners.map((p) => p[0]), ys = corners.map((p) => p[1]);
        return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
      };
      if (variant === "labels") {
        // A box drawn around each page's first line, exactly as it is shown;
        // that line must be gone afterwards, whatever the page's boxes and rotation.
        const doc = await refOpen(bytes, meta.password);
        const marks = [], labels = [];
        for (let i = 1; i <= doc.numPages; i++) {
          const page = await doc.getPage(i);
          const vp = page.getViewport({ scale: 1 });
          const it = (await page.getTextContent()).items.find((t) => t.str.trim());
          if (!it) continue;
          const box = frame(it, vp), pad = 4 / Math.max(vp.width, vp.height);
          marks.push({ page: i - 1, rect: { x: box.x0 - pad, y: box.y0 - pad, w: box.x1 - box.x0 + 2 * pad, h: box.y1 - box.y0 + 2 * pad } });
          labels.push({ page: i - 1, word: it.str.split(" ")[0] });
        }
        await doc.loadingTask.destroy();
        const [o] = await redact(f, marks, { redactDpi: "150" });
        await savePdf(o);
        const s = await pdfSummary(o.blob);
        if (!s.ok) problem(`redact: output unreadable (${s.error})`);
        else {
          const leaked = labels.filter((l) => (s.pages[l.page]?.text ?? "").includes(l.word));
          if (leaked.length) problem(`redact: text inside the box still extractable on page(s) ${leaked.map((l) => `${l.page + 1} (${l.word})`).join(", ")}`);
        }
        break;
      }
      // Secret fixtures: a box over the "SECRET1-4471" line. Others: the top fifth of page 1
      // (bottom 15% for the huge page). The oracle is pdf.js: words fully inside the box must
      // go, words clear of it must stay.
      const rect = meta.secret ? { x: 60 / 612, y: 120 / 792, w: 260 / 612, h: 30 / 792 } : variant === "huge" ? { x: 0, y: 0.85, w: 1, h: 0.15 } : { x: 0, y: 0, w: 1, h: 0.2 };
      const inside = [], outside = [];
      if (refIn && refIn.numPages) {
        const doc = await refOpen(bytes, meta.password);
        const page = await doc.getPage(1);
        const vp = page.getViewport({ scale: 1 });
        for (const it of (await page.getTextContent()).items) {
          if (!it.str?.trim()) continue;
          const box = frame(it, vp);
          const m = 0.01;
          const isIn = box.x0 >= rect.x - m && box.x1 <= rect.x + rect.w + m && box.y0 >= rect.y - m && box.y1 <= rect.y + rect.h + m;
          const isOut = box.x1 < rect.x - m || box.x0 > rect.x + rect.w + m || box.y1 < rect.y - m || box.y0 > rect.y + rect.h + m;
          const toks = it.str.split(/\s+/).filter((t) => t.length >= 4);
          if (isIn) inside.push(...toks);
          else if (isOut) outside.push(...toks);
        }
        await doc.loadingTask.destroy();
      }
      result.info.oracle = { inside: inside.slice(0, 8), outside: outside.length };
      const [o] = await redact(f, [{ page: 0, rect }], { redactDpi: "200" });
      const b = await savePdf(o);
      const s = await pdfSummary(o.blob);
      result.info.out = { size: s.size, numPages: s.numPages };
      if (!s.ok) problem(`redact: output unreadable (${s.error})`);
      else {
        if (refIn && s.numPages !== refIn.numPages) problem(`redact: page count ${refIn.numPages} -> ${s.numPages}`);
        const p1 = s.pages[0]?.text ?? "";
        if (meta.secret && s.text.includes(meta.secret)) problem(`redact: secret "${meta.secret}" still extractable after redaction`);
        if (meta.secret && Buffer.from(b).toString("latin1").includes(meta.secret)) problem(`redact: secret bytes present in output file`);
        else if (meta.secret && (await stored(b)).text.includes(meta.secret)) problem(`redact: secret stored in the output (in an object no page shows)`);
        const leaked = inside.filter((t) => p1.includes(t));
        if (leaked.length) problem(`redact: text inside the box still extractable ${JSON.stringify(leaked.slice(0, 5))}`);
        const lost = outside.filter((t) => !p1.includes(t));
        if (lost.length) problem(`redact: text outside the box lost ${JSON.stringify(lost.slice(0, 5))}`);
        const rest = s.pages.slice(1).map((p) => p.text).join(" ");
        const inRest = (refIn?.pages ?? []).slice(1).map((p) => p.text).join(" ").split(/\s+/).filter((t) => t.length >= 4);
        const lostRest = inRest.filter((t) => !rest.includes(t));
        if (lostRest.length) problem(`redact: text on unmarked pages lost ${JSON.stringify(lostRest.slice(0, 5))}`);
        if (meta.stale && s.text.includes(meta.stale)) problem(`redact: output shows stale/shadow content "${meta.stale}"`);
      }
      break;
    }
    case "protect": {
      const { protect, unlock } = await load("security");
      const pw = { at: "@/in.pdf", dashdash: "--", dash: "-v", unicode: "pässwörd密码", long: "a".repeat(128), space: " ", empty: "" }[variant] ?? "test1234";
      const [p] = await protect(f, { password: pw, allowPrint: true, allowCopy: false, allowModify: false });
      await savePdf(p, 0);
      const locked = new Uint8Array(await p.blob.arrayBuffer());
      // A viewer must need the password (unless empty) and accept it.
      let needsPw = false;
      try { await refInfo(locked, undefined); } catch (e) { needsPw = /password/i.test(e.name + e.message); }
      if (pw && !needsPw) problem(`protect: output opens without the password "${pw}"`);
      let withPw;
      try { withPw = await refInfo(locked, pw); } catch (e) { problem(`protect: output does not open with the chosen password "${pw}" (${e.name})`); }
      if (withPw && refIn && withPw.numPages !== refIn.numPages) problem(`protect: pages ${refIn.numPages} -> ${withPw.numPages}`);
      const [u] = await unlock(fileOf(locked, "locked.pdf"), { password: pw });
      await savePdf(u, 1);
      await samePages(u, "protect->unlock");
      break;
    }
    case "unlock": {
      const { unlock } = await load("security");
      const pw = variant === "wrong" ? "definitely-wrong" : meta.password ?? "";
      const [u] = await unlock(f, { password: pw });
      await savePdf(u);
      if (variant === "wrong" && meta.password) problem(`unlock: accepted a wrong password`);
      await samePages(u, "unlock");
      break;
    }
    case "pdfa": {
      const { pdfToPdfa } = await load("convert");
      const [o] = await pdfToPdfa(f, { pdfaDpi: "200", keepText: true });
      const b = await savePdf(o);
      await samePages(o, "pdfa", { keepAnnots: false, keepExtras: false });
      const str = Buffer.from(b).toString("latin1");
      if (!/pdfaid:part>2</.test(str)) problem("pdfa: no PDF/A identification in XMP");
      break;
    }
    case "repair": {
      const { repair } = await load("optimize");
      const [o] = await repair(f);
      await savePdf(o);
      result.info.note = o.note;
      const s = await pdfSummary(o.blob);
      result.info.out = { size: s.size, numPages: s.numPages };
      if (!s.ok) problem(`repair: output unreadable (${s.error})`);
      else {
        if (refIn && s.numPages !== refIn.numPages) problem(`repair: page count ${refIn.numPages} -> ${s.numPages}`);
        checkWords(s.text, "repair", refIn ? words.filter((w) => inputText.includes(w)) : words);
        if (o.note === "rebuilt") problem("repair: fell back to rasterising pages (text no longer selectable)");
      }
      break;
    }
    default:
      throw new Error("unknown tool " + tool);
  }
  result.ok = true;
} catch (e) {
  // Refusing is the right answer, as long as it's a plain error that says
  // why: for a file that needs a password nobody gave (or a wrong one; a
  // file with only an owner password may also just unlock), and
  // for one even the reference reader can't use (unreadable, or no pages).
  // A TypeError or a blown stack is a bug either way.
  const said = `${e?.code ?? ""} ${e?.name ?? ""} ${e?.message ?? ""}`;
  const plain = e instanceof Error && !(e instanceof TypeError || e instanceof RangeError || e instanceof ReferenceError);
  const needsPassword = ((meta.password && tool !== "unlock") || (meta.encrypted && tool === "unlock" && variant === "wrong")) && /encrypt|password/i.test(said);
  // Protect may also turn down a password longer than PDF allows (127 bytes).
  const tooLong = tool === "protect" && variant === "long" && /too.?long/i.test(said);
  if (plain && (needsPassword || tooLong || !refIn || refIn.numPages === 0)) {
    result.ok = true;
    result.info.refused = said.trim().slice(0, 160);
  } else {
    result.error = { name: e?.constructor?.name ?? typeof e, code: e?.code, message: String(e?.message ?? e).slice(0, 300), stack: String(e?.stack ?? "").split("\n").slice(1, 4).map((l) => l.trim()).join(" | ").slice(0, 400) };
  }
}
result.ms = Date.now() - t0;
result.maxRssMB = Math.round(process.resourceUsage().maxRSS / 1024);
console.log("RESULT " + JSON.stringify(result));
process.exit(0);
