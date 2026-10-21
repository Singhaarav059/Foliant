// On-device AI without a model: how documents are cut into page-sized
// chunks, how the chunks for a question are found, and how an answer's
// citations become page numbers. Then the light chat end to end on a real
// 20-page PDF, with a stand-in for the embedding model.
//
//   node tests/ai.mjs
import { PDFDocument, StandardFonts } from "pdf-lib";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { load, openPdf, check, eq, root, vendorDir } from "./lib/load.mjs";

const { chunkPages } = await load("../ai/chunk");
const { search, fuse, tokens } = await load("../ai/retrieve");
const { numberSources, citations, attribute, extractiveAnswer } = await load("../ai/cite");
const { readPages, askLight } = await load("../ai/chat");
const { translatePdf } = await load("../ai/translate");
const results = { failed: 0 };
const test = check(results);

// No request may leave the page. The Noto fonts translations are drawn in
// come from /vendor, read from disk here.
let requests = 0;
globalThis.fetch = async (url) => {
  const m = String(url).match(/^\/vendor\/[^/]+\/(fonts\/.+)$/);
  if (m) return new Response(readFileSync(join(vendorDir, m[1])));
  requests++;
  throw new Error("network");
};

const words = (n, w = "filler") => Array.from({ length: n }, (_, i) => `${w}${i}`).join(" ") + ".";

await test("chunks: one page each, numbered from 1, empty pages skipped", () => {
  const chunks = chunkPages([
    { page: 1, text: "The cover page. It has two sentences." },
    { page: 2, text: "   " },
    { page: 3, text: "Payment is due in 30 days. The invoice total is $1,234.50." },
  ]);
  eq(chunks.length, 2, "chunks");
  eq(chunks.map((c) => c.page).join(","), "1,3", "pages");
  eq(chunks[1].text.includes("$1,234.50"), true, "text kept");
  eq(chunks.every((c, i) => c.id === i), true, "ids in order");
});

await test("chunks: a long page is cut at sentences, within the word budget, overlapping by one sentence", () => {
  const sentences = Array.from({ length: 12 }, (_, i) => `Sentence ${i} ${words(18, `w${i}x`)}`);
  const chunks = chunkPages([{ page: 7, text: sentences.join(" ") }], { maxWords: 60 });
  eq(chunks.length > 2, true, `several chunks (${chunks.length})`);
  for (const c of chunks) {
    eq(c.page, 7, "page");
    eq(c.text.split(/\s+/).length <= 60, true, `within budget: ${c.text.split(/\s+/).length}`);
  }
  // Each chunk starts with the last sentence of the one before.
  const lastOf = (t) => t.match(/Sentence \d+ /g).at(-1);
  eq(chunks[1].text.startsWith(lastOf(chunks[0].text)), true, "overlap");
  // Every sentence is in some chunk.
  for (let i = 0; i < 12; i++) eq(chunks.some((c) => c.text.includes(`Sentence ${i} `)), true, `sentence ${i}`);
});

await test("chunks: a sentence longer than the budget is cut at words", () => {
  const chunks = chunkPages([{ page: 2, text: words(250) }], { maxWords: 100 });
  eq(chunks.length, 3, "three chunks");
  eq(chunks.every((c) => c.text.split(/\s+/).length <= 100), true, "within budget");
});

await test("tokens: lower case, stop words out, plurals folded, CJK as bigrams", () => {
  eq(tokens("What is the Invoice total?").join(" "), "invoice total", "English");
  eq(tokens("Invoices and totals").join(" "), "invoice total", "plurals");
  eq(tokens("請求書の合計").join(" "), "請求 求書 書の の合 合計", "CJK bigrams");
});

const invoice = [
  { page: 1, text: "Quarterly report. Revenue grew 12 percent this quarter, driven by renewals." },
  { page: 2, text: "The team hired four engineers. Office costs stayed flat." },
  { page: 3, text: "Invoice INV-2041 from Acme Ltd. The invoice total is $1,234.50, due on 30 November." },
  { page: 4, text: "Totals for travel were lower than planned. The board met twice." },
];

await test("search: 'what is the invoice total' finds page 3 first", () => {
  const hits = search(chunkPages(invoice), "what is the invoice total", { k: 3 });
  eq(hits[0].chunk.page, 3, "top page");
  eq(hits.length <= 3, true, "at most k");
  eq(hits.every((h, i) => i === 0 || h.score <= hits[i - 1].score), true, "best first");
});

await test("search: embeddings fused with keywords (reciprocal rank fusion)", () => {
  const chunks = chunkPages(invoice);
  // A stand-in embedding that only knows page 2 is about staff.
  const vec = (t) => (/engineer|staff|hire/i.test(t) ? [1, 0] : [0, 1]);
  const hits = search(chunks, "how many staff joined", { k: 2, vectors: { query: vec("staff"), chunks: chunks.map((c) => vec(c.text)) } });
  eq(hits[0].chunk.page, 2, "meaning wins when no keyword matches");
  const fused = fuse([[{ id: 1 }, { id: 2 }], [{ id: 2 }, { id: 3 }]], (x) => x.id);
  eq(fused.map((x) => x.item.id).join(","), "2,1,3", "fused order");
});

await test("sources: numbered, with their pages, for the prompt", () => {
  const hits = search(chunkPages(invoice), "invoice total", { k: 2 });
  const { sources, context } = numberSources(hits);
  eq(sources[0].n, 1, "numbered from 1");
  eq(sources[0].page, 3, "page");
  eq(context.split("\n")[0].startsWith("[1] (page 3) Invoice INV-2041"), true, `context: ${context.split("\n")[0]}`);
});

await test("citations: [n], [n, m], [n][m], (page n) and [p. n] become pages; unknown ones are dropped", () => {
  const sources = [{ n: 1, page: 3, text: "a" }, { n: 2, page: 9, text: "b" }];
  const r = citations("The total is $1,234.50 [1]. It is due soon [1, 2][2]. See (page 9) and [p. 3]. Not [7].", sources);
  eq(r.pages.join(","), "3,9", "pages, in order, once each");
  eq(r.parts.map((p) => p.text).join("|"), "The total is $1,234.50|. It is due soon|. See|and|. Not|.", "text without markers");
  eq(JSON.stringify(r.parts.map((p) => p.pages ?? [])), JSON.stringify([[3], [3, 9], [9], [3], [], []]), "pages per part");
  // Lead-ins to a marker go: the page chip says it.
  eq(citations("The total is $1,234.50, cited in [1].", sources).parts.map((p) => p.text).join("|"), "The total is $1,234.50|.", "cited in");
  eq(citations("It is due soon (see [2]).", sources).parts.map((p) => p.text).join("|"), "It is due soon|.", "see");
  // A page the answer names that no source has is not a citation.
  eq(citations("On page 40 [p. 40].", sources).pages.length, 0, "unknown page");
});

await test("attribution: an answer without citations gets the sources it borrows from", () => {
  const sources = [{ n: 1, page: 3, text: "The invoice total is $1,234.50, due on 30 November." }, { n: 2, page: 2, text: "The team hired four engineers." }];
  eq(attribute("The invoice total is $1,234.50.", sources).join(","), "3", "page 3");
  eq(attribute("I don't know.", sources).length, 0, "nothing borrowed");
});

await test("extractive answer: the sentences that answer, each with its page", () => {
  const hits = search(chunkPages(invoice), "what is the invoice total", { k: 3 });
  const answer = extractiveAnswer("what is the invoice total", hits);
  eq(answer[0].page, 3, "page");
  eq(answer[0].text, "The invoice total is $1,234.50, due on 30 November.", "sentence");
  eq(answer.length <= 3, true, "short");
  // By meaning: sentences far behind the best are left out.
  const two = [{ chunk: { id: 0, page: 1, text: "Alpha is first. Beta is second. Gamma is third." }, score: 1 }];
  const kept = extractiveAnswer("which is first", two, { similar: [0.62, 0.15, 0.55] });
  eq(kept.map((k) => k.text).join("|"), "Alpha is first.|Gamma is third.", "close ones only");
});

// A 20-page PDF: report filler, with the invoice on page 14.
async function twenty() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= 20; i++) {
    const page = doc.addPage([595, 842]);
    const lines = i === 14
      ? ["Invoice INV-2041", "Bill to: Northwind Traders", "Consulting services, October: $1,100.00", "Tax: $134.50", "The invoice total is $1,234.50, due on 30 November."]
      : [`Section ${i}`, `This section describes project milestone ${i} and the risks the team saw.`, "Weekly meetings kept everyone informed about progress."];
    lines.forEach((l, j) => page.drawText(l, { x: 60, y: 760 - j * 22, size: 12, font }));
  }
  return new File([await doc.save()], "twenty.pdf", { type: "application/pdf" });
}

await test("twenty pages: read page by page, then the light chat cites page 14 for the invoice total", async () => {
  const file = await twenty();
  // pdf.js in Node runs its worker in the main thread once a document has been opened directly.
  await openPdf(new Uint8Array(await file.arrayBuffer()));
  const pages = await readPages(file);
  eq(pages.length, 20, "pages");
  eq(pages[13].page, 14, "numbered from 1");
  eq(pages[13].text.includes("$1,234.50"), true, "page 14 text");
  // Lines repeated on every page count as headers and footers in the layout; they're still text.
  eq(pages[0].text.includes("project milestone 1 "), true, `page 1 text: ${pages[0].text}`);
  const answer = await askLight(pages, "What is the invoice total?");
  eq(answer.pages[0], 14, `cites page 14 (got ${answer.pages})`);
  eq(answer.parts.map((p) => p.text).join(" ").includes("$1,234.50"), true, "the amount");
  eq(requests, 0, "requests");
});

// A stand-in translator: tags each block, so the output shows what was translated.
const tagged = { engine: "test", done() {}, translate: async (s) => `ES[${s.length}] ${s.split(" ").reverse().join(" ")}` };
const pdfText = async (bytes) => {
  const doc = await openPdf(bytes);
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) pages.push((await (await doc.getPage(i)).getTextContent()).items.map((it) => it.str).join(" "));
  return pages;
};

await test("translate report.pdf, keep layout: same pages, only translated text, nothing fetched", async () => {
  const bytes = readFileSync(join(root, "tests/fixtures/report.pdf"));
  const before = await pdfText(new Uint8Array(bytes));
  const [out] = await translatePdf(new File([bytes], "report.pdf"), { translateLang: "es", translateFormat: "pdf" }, undefined, tagged);
  eq(out.name, "report-es.pdf", "name");
  eq(out.note, "translate:test", "note");
  const after = await pdfText(new Uint8Array(await out.blob.arrayBuffer()));
  eq(after.length, before.length, "page count");
  const text = after.join(" ");
  eq((text.match(/ES\[/g) ?? []).length > 3, true, `translated blocks (${text.slice(0, 120)})`);
  eq(text.includes("Revenue grew 12 percent"), false, "original text taken out");
  // Numbers aren't translated, but they're still there.
  eq(text.includes("1,200") && text.includes("2,210"), true, "table figures kept");
  eq(requests, 0, "requests");
});

await test("translate to Markdown: the translated blocks, page by page, headings kept", async () => {
  const bytes = readFileSync(join(root, "tests/fixtures/report.pdf"));
  const [out] = await translatePdf(new File([bytes], "report.pdf"), { translateLang: "es", translateFormat: "md" }, undefined, tagged);
  const md = await out.blob.text();
  eq(out.name, "report-es.md", "name");
  eq(/^#{2,4} ES\[/m.test(md), true, `a heading (${md.slice(0, 120)})`);
  eq(md.split("\n\n").filter((b) => b.startsWith("ES[")).length > 2, true, "paragraphs");
});

await test("translate without a translator: a clear error, not English output", async () => {
  const bytes = readFileSync(join(root, "tests/fixtures/report.pdf"));
  let code = "";
  try {
    await translatePdf(new File([bytes], "report.pdf"), { translateLang: "es", translateFormat: "pdf" });
  } catch (e) {
    code = e.code;
  }
  eq(code, "no_translator", "error code");
});

console.log(results.failed ? `\n${results.failed} failed` : "\nall passed");
process.exit(results.failed ? 1 : 0);
