// Chat with a PDF. The document is read page by page (text layer first,
// OCR for pages that are pictures of text), cut into chunks (./chunk.ts) and
// indexed (./retrieve.ts). A question finds its chunks; then either
//  - light: the sentences that answer it best are shown, each with its page, or
//  - a language model on this device writes the answer from those chunks,
//    citing them, and the citations become pages (./cite.ts).
// Nothing leaves the device: the models run here (./engine.ts).

import { closePdf, openPdf, type Progress } from "../pdf/common";
import { documentLayout, type PageLayout } from "../pdf/layout";
import { blocks, bodySizeOf, type Line } from "../pdf/text";
import { chunkPages, type Chunk, type PageText } from "./chunk";
import { answerSentences, attribute, citations, extractiveAnswer, numberSources, type Answer } from "./cite";
import { cosine, search, type Hit } from "./retrieve";

export type { Answer, Part } from "./cite";
export type { PageText } from "./chunk";

// Pages with this many characters or fewer, and nothing else to go on, are read by OCR.
const SCANNED = 40;

const linesOf = (l: PageLayout) =>
  l.sections.flatMap((s) => s.columns.flatMap((c) => c.items.flatMap((it) => (it.kind === "lines" ? [it.lines] : []))));

// Each page's text in reading order: paragraphs, headings and list items on
// lines of their own, table rows with their cells joined by " | ". Header
// and footer lines (text repeated on most pages) are kept: a document can be
// mostly repeated lines, and repeated words count for little in the index.
export async function readPages(file: File, o: { ocrLang?: string } = {}, progress?: Progress): Promise<PageText[]> {
  const doc = await openPdf(await file.arrayBuffer());
  try {
    const layouts = await documentLayout(doc, (i) => progress?.(i, doc.numPages * 2));
    const body = bodySizeOf(layouts.map((l) => ({ lines: linesOf(l).flat() })));
    const pages = layouts.map((layout, i) => {
      const out: string[] = layout.header.map((l) => l.text.trim());
      for (const s of layout.sections)
        for (const c of s.columns)
          for (const it of c.items) {
            if (it.kind === "lines") for (const b of blocks(it.lines as Line[], body)) out.push(b.text.trim());
            else if (it.kind === "table") {
              const rows = new Map<number, string[]>();
              for (const cell of [...it.table.cells].sort((a, b) => a.row - b.row || a.col - b.col))
                rows.set(cell.row, [...(rows.get(cell.row) ?? []), cell.text.trim()]);
              for (const r of rows.values()) out.push(r.filter(Boolean).join(" | "));
            }
          }
      out.push(...layout.footer.map((l) => l.text.trim()));
      return { page: i + 1, text: out.filter(Boolean).join("\n") };
    });
    const scanned = pages.filter((p) => p.text.replace(/\s/g, "").length <= SCANNED).map((p) => p.page);
    if (scanned.length && o.ocrLang && typeof document !== "undefined") {
      const read = await ocrPages(doc, scanned, o.ocrLang, (d) => progress?.(doc.numPages + (d / scanned.length) * doc.numPages, doc.numPages * 2));
      for (const [page, text] of read) if (text.trim()) pages[page - 1].text = text;
    }
    progress?.(1, 1);
    return pages;
  } finally {
    await closePdf(doc);
  }
}

// The OCR tool's engine and page reader (../pdf/ocr.ts), at 200 dpi. Words
// come back in reading order: lines of a paragraph, paragraphs of a block.
async function ocrPages(doc: Awaited<ReturnType<typeof openPdf>>, pages: number[], lang: string, done: (n: number) => void) {
  const [{ engine, readPage }, { grayOf }, { renderPage }] = await Promise.all([import("../pdf/ocr"), import("../pdf/ocrprep"), import("../pdf/common")]);
  const out = new Map<number, string>();
  const ocr = await engine.create(lang, 1);
  try {
    for (const n of pages) {
      const page = await doc.getPage(n);
      const canvas = await renderPage(page, 200 / 72);
      const image = grayOf(canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height));
      canvas.width = canvas.height = 0;
      page.cleanup();
      const { words } = await readPage(ocr.recognise, image);
      out.set(n, words.map((w) => w.text).join(" "));
      done(out.size);
    }
  } finally {
    await ocr.stop();
  }
  return out;
}

// Embeds texts with the light model: one unit-length vector each.
export type Embed = (texts: string[]) => Promise<number[][]>;

export type DocIndex = { pages: PageText[]; chunks: Chunk[]; vectors?: number[][] };

export async function buildIndex(pages: PageText[], embed?: Embed): Promise<DocIndex> {
  const chunks = chunkPages(pages);
  return { pages, chunks, vectors: embed && chunks.length ? await embed(chunks.map((c) => c.text)) : undefined };
}

async function find(index: DocIndex, question: string, k: number, embed?: Embed): Promise<Hit[]> {
  const vectors = index.vectors && embed ? { query: (await embed([question]))[0], chunks: index.vectors } : undefined;
  return search(index.chunks, question, { k, vectors });
}

// Light: the document's own sentences that answer the question, each citing its page.
export async function askLight(input: PageText[] | DocIndex, question: string, embed?: Embed): Promise<Answer> {
  const index = Array.isArray(input) ? await buildIndex(input, embed) : input;
  const hits = await find(index, question, 4, embed);
  let similar: number[] | undefined;
  if (embed && index.vectors) {
    const list = answerSentences(hits);
    if (list.length) {
      const [q, ...vs] = await embed([question, ...list]);
      similar = vs.map((v) => cosine(q, v));
    }
  }
  const sentences = extractiveAnswer(question, hits, { similar });
  return { parts: sentences.map((s) => ({ text: s.text, pages: [s.page] })), pages: [...new Set(sentences.map((s) => s.page))] };
}

export type Message = { role: "system" | "user" | "assistant"; content: string };
// Streams the model's reply; `onText` gets the text so far.
export type Generate = (messages: Message[], o: { maxNewTokens: number; onText?: (text: string) => void; signal?: AbortSignal }) => Promise<string>;

// The instructions. English: the small models follow English instructions
// best, and are told to answer in the question's language.
export const SYSTEM =
  "You answer questions about a document using only the numbered sources from it. " +
  "Cite every fact with its source number in square brackets, like [1] or [2][3]. " +
  "If the sources don't contain the answer, say you couldn't find it in the document. " +
  "Answer briefly, in the language of the question.";

// With a model: the answer written from the best chunks, with its citations
// as pages. Earlier turns (questions and answers, without their sources)
// come along so follow-up questions make sense.
export async function askModel(
  index: DocIndex,
  question: string,
  o: { generate: Generate; embed?: Embed; history?: Message[]; onPartial?: (a: Answer) => void; signal?: AbortSignal; k?: number },
): Promise<Answer> {
  const hits = await find(index, question, o.k ?? 4, o.embed);
  const { sources, context } = numberSources(hits);
  const messages: Message[] = [
    { role: "system", content: SYSTEM },
    ...(o.history ?? []).slice(-4),
    { role: "user", content: `Sources:\n${context}\n\nQuestion: ${question}` },
  ];
  const text = await o.generate(messages, {
    maxNewTokens: 320,
    signal: o.signal,
    onText: o.onPartial && ((t) => o.onPartial!(citations(t, sources))),
  });
  const answer = citations(text, sources);
  // No markers: cite the sources the answer's words come from.
  if (!answer.pages.length && answer.parts.length) {
    const pages = attribute(text, sources);
    if (pages.length) return { parts: [{ text: answer.parts.map((p) => p.text).join(" "), pages }], pages };
  }
  return answer;
}
