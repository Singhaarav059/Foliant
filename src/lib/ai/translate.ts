"use client";

// Translate PDF. Text goes, block by block (paragraphs, headings, list items,
// table cells, headers and footers), to the cloud AI in batches when it's
// picked (the default where the site has it; ./cloud.ts: the blocks' text
// is sent, never the file). Otherwise, or for the rest when the cloud stops
// answering, to the browser's built-in Translator when it has this language
// pair on the device, else to the large model (Qwen3-0.6B, Apache-2.0) when
// the visitor has downloaded it. There is no other fallback: the
// permissively licensed translation-only models were either too large or
// not clearly licensed, so without one of these the tool says how to get one.
//
// Output: Markdown (the text, page by page), or a PDF that keeps the layout:
// the original text is taken out (../pdf/strip.ts), graphics and pictures
// stay, and each block's translation is drawn in its box in Noto
// (../pdf/fonts.ts), smaller if it needs the room. Same pages, same order.

import { PDFDocument, degrees, rgb } from "pdf-lib";
import { baseName, bytesOf, closePdf, hexToRgb, openPdf, pdfBlob, type Output, type Progress } from "../pdf/common";
import { PdfError } from "../pdf/errors";
import { documentLayout, type PageLayout } from "../pdf/layout";
import { blocks, bodySizeOf, type Line } from "../pdf/text";
import { guessLanguage } from "./extractive";
import { languageTag } from "./summarize";

// A piece of text and the box it sat in (viewport points, top-left origin).
// `room`: how wide its translation may run, to the edge of its column.
export type Unit = { page: number; text: string; x: number; y: number; w: number; h: number; room: number; size: number; bold: boolean; color?: string; heading?: number };
export type Translate = (text: string) => Promise<string>;
type Engine = { translate: Translate; engine: string; done(): void; many?: (texts: string[]) => Promise<string[]>; provider?: string };

const linesOf = (l: PageLayout) =>
  l.sections.flatMap((s) => s.columns.flatMap((c) => c.items.flatMap((it) => (it.kind === "lines" ? [it.lines] : []))));

const boxOf = (lines: Line[]) => {
  const x = Math.min(...lines.map((l) => l.x));
  const y = Math.min(...lines.map((l) => l.y));
  return { x, y, w: Math.max(...lines.map((l) => l.x + l.w)) - x, h: Math.max(...lines.map((l) => l.y + l.size * 1.2)) - y };
};

export function unitsOf(layouts: PageLayout[]): Unit[] {
  const body = bodySizeOf(layouts.map((l) => ({ lines: linesOf(l).flat() })));
  const units: Unit[] = [];
  layouts.forEach((layout, i) => {
    const page = i + 1;
    const line = (l: Line) => units.push({ page, text: l.text, ...boxOf([l]), room: layout.width - 36 - l.x, size: l.size, bold: l.bold, color: l.runs[0]?.color });
    layout.header.forEach(line);
    for (const s of layout.sections)
      for (const c of s.columns)
        for (const it of c.items) {
          if (it.kind === "lines")
            for (const b of blocks(it.lines as Line[], body))
              units.push({ page, text: b.text, ...boxOf(b.lines), room: c.x1 - boxOf(b.lines).x, size: b.size, bold: b.bold, color: b.lines[0].runs[0]?.color, heading: b.kind === "heading" ? b.level : undefined });
          else if (it.kind === "table")
            for (const cell of it.table.cells)
              if (cell.text.trim()) units.push({ page, text: cell.text, x: cell.x + 2, y: cell.y + 1, w: cell.w - 4, h: cell.h - 2, room: cell.w - 4, size: cell.lines[0]?.size ?? body, bold: cell.bold, color: cell.lines[0]?.runs[0]?.color });
        }
    layout.footer.forEach(line);
  });
  return units;
}

// Numbers, codes and the like stay as they are.
const words = (u: Unit) => /\p{L}{2}/u.test(u.text);

// The cloud AI (./cloud.ts) translates blocks in batches of up to this many
// characters (functions/api/ai.ts takes 12,000) and blocks.
const BATCH = { chars: 9_000, items: 80 };

// The cloud translator: batches of blocks, each sent as text only. A batch
// that comes back incomplete is split and tried again; a block that still
// fails, or a cloud that doesn't answer, throws CloudUnavailable.
async function cloudTranslator(to: string, aiModel: string): Promise<Engine> {
  const { cloudJson, CloudUnavailable, providerFor } = await import("./cloud");
  const engine: Engine = { engine: "cloud", done: () => {}, translate: async (text) => (await batch([text]))[0] };
  const batch = async (texts: string[]): Promise<string[]> => {
    try {
      const { data, provider } = await cloudJson<{ texts: string[] }>({ task: "translate", texts, language: to, ...providerFor(aiModel) });
      // The backup answered any part: say so.
      if (engine.provider !== "cloudflare") engine.provider = provider;
      if (data.texts?.length === texts.length) return data.texts;
      throw new CloudUnavailable("incomplete");
    } catch (e) {
      // Split only an incomplete batch (502 from the endpoint); anything else means the cloud isn't answering.
      if (texts.length === 1 || !(e instanceof CloudUnavailable) || !/^(502|incomplete)/.test(e.message)) throw e;
      const half = Math.ceil(texts.length / 2);
      return [...(await batch(texts.slice(0, half))), ...(await batch(texts.slice(half)))];
    }
  };
  engine.many = batch;
  return engine;
}

// Groups of block indexes, each group within BATCH.
function batches(texts: string[]): number[][] {
  const out: number[][] = [];
  let cur: number[] = [];
  let chars = 0;
  texts.forEach((t, i) => {
    if (cur.length && (chars + t.length > BATCH.chars || cur.length >= BATCH.items)) {
      out.push(cur);
      cur = [];
      chars = 0;
    }
    cur.push(i);
    chars += t.length;
  });
  if (cur.length) out.push(cur);
  return out;
}

// The translator to use, or null: the browser's when it has the pair, else
// the large model when it's on the device.
export async function translator(from: string | undefined, to: string, aiModel?: string): Promise<Engine | null> {
  if (aiModel === "cloud" || aiModel === "cloudflare") return cloudTranslator(to, aiModel);
  if (aiModel !== "large" && !("Translator" in globalThis)) return null;
  const { builtinTranslator, status, generator } = await import("./engine");
  if (from) {
    const t = await builtinTranslator(from, to);
    if (t) return { translate: (s) => t.translate(s), engine: "builtin", done: () => t.destroy?.() };
  }
  if (aiModel !== "large") return null;
  if (!(await status()).stored.large) return null;
  const generate = generator("large");
  const name = languageName(to);
  return {
    engine: "model",
    done: () => {},
    translate: async (text) => {
      const out = await generate(
        [
          { role: "system", content: `You are a professional translator into ${name}.` },
          { role: "user", content: `Translate into ${name}:\n\n${text}` },
        ],
        { maxNewTokens: Math.min(1024, 40 + text.length) },
      );
      // A label or quotes around the translation, and anything after it when the text was one paragraph.
      let t = out.trim().replace(/^(translation|traducción|traduction|übersetzung)[^:\n]*:\s*/i, "").replace(/^["“«]([\s\S]*)["”»]$/, "$1");
      if (!text.includes("\n")) t = t.split(/\n\s*\n/)[0];
      return t.trim() || text;
    },
  };
}

const languageName = (tag: string) => {
  try {
    return new Intl.DisplayNames(["en"], { type: "language" }).of(tag) ?? tag;
  } catch {
    return tag;
  }
};

// Lines of `text` no wider than `width` at `size`, broken at spaces (or
// anywhere, for scripts written without them).
async function wrap(measure: (s: string) => Promise<number | null>, text: string, width: number) {
  const spaced = /\s/.test(text.trim());
  const pieces = spaced ? text.split(/\s+/).filter(Boolean) : Array.from(text);
  const join = spaced ? " " : "";
  const lines: string[] = [];
  let cur = "";
  for (const p of pieces) {
    const next = cur ? cur + join + p : p;
    const w = await measure(next);
    if (w === null) return null;
    if (w > width && cur) {
      lines.push(cur);
      cur = p;
    } else cur = next;
  }
  if (cur) lines.push(cur);
  return lines;
}

// Draws each unit's translation in its box, on a copy of the PDF without its text.
async function drawPdf(bytes: Uint8Array, layouts: PageLayout[], units: Unit[], done: string[]) {
  const [{ withoutText }, { layoutText }, { pdfjs }] = await Promise.all([import("../pdf/strip"), import("../pdf/fonts"), import("../pdf/common")]);
  const doc = await PDFDocument.load(await withoutText(bytes), { updateMetadata: false });
  const src = await openPdf(bytes);
  try {
    await pdfjs();
    for (let i = 0; i < doc.getPageCount(); i++) {
      const page = doc.getPage(i);
      const view = (await src.getPage(i + 1)).getViewport({ scale: 1, rotation: layouts[i].rotation });
      const toPdf = (x: number, y: number) => view.convertToPdfPoint(x, y) as [number, number];
      const [ox, oy] = toPdf(0, 0);
      const [ux, uy] = toPdf(1, 0);
      const angle = (Math.atan2(uy - oy, ux - ox) * 180) / Math.PI;
      for (const [k, u] of units.entries()) {
        if (u.page !== i + 1) continue;
        const text = done[k];
        let size = u.size;
        let lines: string[] | null = null;
        // Shrink until it fits the box (a little overflow is allowed), down to 60% or 5 pt.
        for (; ; size *= 0.9) {
          const s = size;
          lines = await wrap(async (t) => (await layoutText(doc, t, s, u.bold))?.width ?? null, text, Math.max(u.w, u.room, s * 4));
          if (!lines || lines.length * s * 1.15 <= u.h * 1.1 + s * 0.3 || size < Math.max(5, u.size * 0.6)) break;
        }
        if (!lines) continue;
        const { r, g, b } = u.color ? hexToRgb(u.color) : { r: 0, g: 0, b: 0 };
        for (const [n, line] of lines.entries()) {
          const laid = await layoutText(doc, line, size, u.bold);
          if (!laid) continue;
          for (const run of laid.runs) {
            // Baseline of line n, then the run's offset along it.
            const [x, y] = toPdf(u.x + run.x, u.y + size * (0.85 + n * 1.15));
            page.drawText(run.text, { x, y, size, font: run.font, color: rgb(r, g, b), rotate: degrees(angle) });
          }
        }
      }
    }
  } finally {
    await closePdf(src);
  }
  return doc.save({ useObjectStreams: true });
}

export async function translatePdf(
  file: File,
  o: { translateLang: string; translateFormat: string; aiModel?: string },
  progress?: Progress,
  // Tests pass their own.
  engine?: Engine,
): Promise<Output[]> {
  const bytes = await bytesOf(file);
  const doc = await openPdf(bytes.slice());
  let layouts: PageLayout[];
  try {
    layouts = await documentLayout(doc, (i) => progress?.(i, doc.numPages * 4));
  } finally {
    await closePdf(doc);
  }
  const units = unitsOf(layouts);
  if (!units.some(words)) throw new PdfError("no_text", file.name);
  const to = languageTag(o.translateLang);
  const from = guessLanguage(units.filter(words).map((u) => u.text).join("\n"));
  let t = engine ?? (await translator(from, to, o.aiModel));
  if (!t) throw new PdfError("no_translator", file.name);
  // Blocks with words are translated; numbers, codes and the like stay.
  const done = units.map((u) => u.text);
  const todo = units.flatMap((u, k) => (words(u) ? [k] : []));
  const source = (k: number) => units[k].text.replace(/\s+/g, " ").trim();
  let n = 0;
  const step = () => progress?.(layouts.length + (n / Math.max(1, todo.length)) * layouts.length * 2, layouts.length * 4);
  let cloudFailed = false;
  try {
    if (t.many) {
      try {
        for (const group of batches(todo.map(source))) {
          const out = await t.many(group.map((i) => source(todo[i])));
          group.forEach((i, j) => (done[todo[i]] = out[j].trim() || units[todo[i]].text));
          n += group.length;
          step();
        }
      } catch (e) {
        const { CloudUnavailable } = await import("./cloud");
        if (!(e instanceof CloudUnavailable)) throw e;
        // The rest on this device: the browser's translator or the large model, if there's one.
        console.warn("The cloud AI didn't answer; translating the rest on this device.", e);
        cloudFailed = true;
        const local = await translator(from, to, "large");
        if (!local) throw new PdfError("cloud_failed", file.name);
        t = local;
      }
    }
    for (; n < todo.length; n++) {
      done[todo[n]] = (await t.translate(source(todo[n]))).trim() || units[todo[n]].text;
      step();
    }
  } finally {
    t.done();
  }
  const note = `translate:${t.engine}${t.provider ? `:${t.provider}` : ""}${cloudFailed ? ":cloudFailed" : ""}`;
  const stem = `${baseName(file.name)}-${to}`;
  if (o.translateFormat === "md") {
    const md: string[] = [];
    let page = 0;
    units.forEach((u, k) => {
      if (u.page !== page) {
        page = u.page;
        if (layouts.length > 1) md.push(`<!-- page ${page} -->`);
      }
      md.push(u.heading ? `${"#".repeat(u.heading + 1)} ${done[k]}` : done[k]);
    });
    progress?.(1, 1);
    return [{ name: `${stem}.md`, blob: new Blob([md.join("\n\n") + "\n"], { type: "text/markdown" }), note }];
  }
  const out = await drawPdf(bytes, layouts, units, done);
  progress?.(1, 1);
  return [{ name: `${stem}.pdf`, blob: pdfBlob(out), note }];
}
