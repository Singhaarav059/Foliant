// On-device AI in real browsers. Chat with PDF answers "What is the invoice
// total?" on a 20-page PDF with the right page citation: first with no model
// at all, then with the light model the visitor chooses to download. The
// model comes from this site only after the click, works again after a
// reload with no network, and no request ever leaves the site. Summarize
// stays fast without WebGPU.
//
// AI_LARGE=1 also downloads the small (273 MB) and large (570 MB) models and
// runs them (WebGPU in Chrome; slow on the CPU elsewhere): a written answer
// citing page 14, a model summary, and report.pdf translated into Spanish
// with the same page count. It prints load times and Chrome's memory.
//
//   node tests/e2e/ai.mjs [chromium] [firefox] [webkit]   (see kit.mjs)
import { PDFDocument, StandardFonts } from "pdf-lib";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { base, dict, open, pick, suite } from "./kit.mjs";

const t = dict("en");
const origin = new URL(base).origin;
const large = process.env.AI_LARGE === "1";
const dir = mkdtempSync(join(tmpdir(), "e2e-ai-"));

// Twenty pages of project notes, with the invoice on page 14.
const twenty = join(dir, "twenty.pdf");
{
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= 20; i++) {
    const page = doc.addPage([595, 842]);
    const lines = i === 14
      ? ["Invoice INV-2041", "Bill to: Northwind Traders", "Consulting services, October: $1,100.00", "Tax: $134.50", "The invoice total is $1,234.50, due on 30 November."]
      : [`Section ${i}`, `This section describes project milestone ${i} and the risks the team saw.`, "Weekly meetings kept everyone informed about progress."];
    lines.forEach((l, j) => page.drawText(l, { x: 60, y: 760 - j * 22, size: 12, font }));
  }
  writeFileSync(twenty, await doc.save());
}

// Asks a question and waits for the finished answer: its text and the pages it cites.
async function ask(page, question, timeout = 60000) {
  const n = await page.locator("[data-answer]").count();
  await page.getByLabel(t["chat.ask"]).fill(question);
  await page.getByRole("button", { name: t["chat.send"], exact: true }).click();
  const answer = page.locator("[data-answer]").nth(n);
  await page.waitForFunction((i) => document.querySelectorAll("[data-answer]")[i]?.getAttribute("data-answer") === "done", n, { timeout });
  const pages = await answer.locator("[data-citation]").evaluateAll((els) => els.map((e) => Number(e.getAttribute("data-citation"))));
  return { text: (await answer.innerText()).trim(), pages };
}

const models = (page) => page.locator("[data-ai-models]");
// The download button of one model: the row that names it.
const row = (page, id) => models(page).locator("li").filter({ hasText: t[`ai.model.${id}`] });
async function download(page, id, timeout) {
  const t0 = Date.now();
  await row(page, id).getByRole("button").click();
  await row(page, id).getByRole("radio").waitFor({ timeout });
  return Date.now() - t0;
}

await suite(async ({ browser, test }) => {
  const ctx = await browser.newContext({ locale: "en-US", viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const away = [];
  const modelFiles = [];
  if (process.env.DEBUG_AI) {
    page.on("console", (m) => /error|warn/.test(m.type()) && console.log("console:", m.text().slice(0, 200)));
    page.on("worker", (w) => w.on("console", (m) => console.log("worker:", m.text().slice(0, 200))));
    page.on("requestfailed", (r) => console.log("failed:", r.url().slice(0, 100), r.failure()?.errorText));
  }
  ctx.on("request", (r) => {
    const url = r.url();
    if (!url.startsWith(origin) && !/^(data|blob):/.test(url)) away.push(url);
    if (url.includes("/vendor/models/")) modelFiles.push(url);
  });

  await test("no model: cites page 14 for the invoice total, downloads nothing", async () => {
    await open(page, "/en/chat-with-pdf");
    await pick(page, [twenty]);
    await page.getByLabel(t["chat.ask"]).waitFor();
    await page.waitForFunction(() => !document.querySelector("#chat-q")?.disabled, null, { timeout: 30000 });
    const a = await ask(page, "What is the invoice total?");
    if (a.pages[0] !== 14) throw new Error(`cited ${a.pages}: ${a.text}`);
    if (!a.text.includes("$1,234.50")) throw new Error(a.text);
    if (modelFiles.length) throw new Error(`fetched ${modelFiles[0]}`);
    return `cites p. ${a.pages.join(", ")}`;
  });

  await test("a citation shows its page", async () => {
    await page.getByRole("button", { name: t["chat.nextPage"] }).click();
    await page.locator("[data-citation='14']").first().click();
    await page.locator("[data-chat-page='14']").waitFor({ timeout: 5000 });
    return "page 14 shown";
  });

  let ms = 0;
  await test("light model: downloads on request, then answers by meaning", async () => {
    ms = await download(page, "light", 120000);
    const a = await ask(page, "How much do we owe Northwind in total?");
    if (a.pages[0] !== 14) throw new Error(`cited ${a.pages}: ${a.text}`);
    const by = await page.locator("[data-answer]").last().innerText();
    if (!by.includes(t["chat.by.light"])) throw new Error(`not the light model: ${by}`);
    const parts = new Set(modelFiles.map((u) => u.split("/vendor/models/")[1].split("/")[0]));
    if ([...parts].some((p) => !p.startsWith("light-"))) throw new Error(`fetched ${[...parts]}`);
    return `downloaded in ${ms} ms, cites p. ${a.pages.join(", ")}`;
  });

  await test("after a reload, offline: the model is still here and answers", async () => {
    await open(page, "/en/chat-with-pdf");
    // The service worker keeps the page's code once it controls the page,
    // and the page loads the AI worker and, with a model on the device, its
    // runtime for it (src/lib/offline.ts); the runtime's .mjs comes last.
    await page.waitForFunction(async () => {
      if (!navigator.serviceWorker.controller) return false;
      for (const name of await caches.keys()) if ((await (await caches.open(name)).keys()).some((r) => r.url.includes("ort-wasm-simd-threaded.asyncify.mjs"))) return true;
      return false;
    }, null, { timeout: 30000, polling: 250 });
    // Settled, as in offline.mjs: no hidden frame, nothing new cached for a second.
    const cachedCount = () => page.evaluate(async () => {
      let n = 0;
      for (const name of await caches.keys()) n += (await (await caches.open(name)).keys()).length;
      return document.querySelector("iframe") ? -1 : n;
    });
    for (let before = -2, now = await cachedCount(); before !== now || now < 0; ) {
      before = now;
      await page.waitForTimeout(1000);
      now = await cachedCount();
    }
    const before = modelFiles.length;
    await ctx.setOffline(true);
    try {
      await pick(page, [twenty]);
      await page.waitForFunction(() => !document.querySelector("#chat-q")?.disabled, null, { timeout: 30000 });
      await row(page, "light").getByRole("radio").waitFor({ timeout: 10000 });
      const a = await ask(page, "What is the invoice total?");
      if (a.pages[0] !== 14) throw new Error(`cited ${a.pages}`);
      if (modelFiles.length !== before) throw new Error("fetched the model again");
    } finally {
      await ctx.setOffline(false);
    }
    return "answered offline";
  });

  await test("summary without a model in under 10 s", async () => {
    await open(page, "/en/summarize-pdf");
    await pick(page, [twenty]);
    const t0 = Date.now();
    await page.getByRole("button", { name: t["tool.summarize.action"], exact: true }).click();
    await page.locator("[data-summary]").waitFor({ timeout: 10000 });
    const ms = Date.now() - t0;
    if (ms > 10000) throw new Error(`${ms} ms`);
    return `${ms} ms`;
  });

  if (large) {
    const gpu = await page.evaluate(async () => {
      const a = await navigator.gpu?.requestAdapter();
      return a ? (a.features.has("shader-f16") ? "WebGPU with f16" : "WebGPU without f16") : "no WebGPU";
    });
    for (const id of ["small", "large"]) {
      await test(`${id} model: written answer citing page 14 (${gpu})`, async () => {
        await open(page, "/en/chat-with-pdf");
        await pick(page, [twenty]);
        await page.waitForFunction(() => !document.querySelector("#chat-q")?.disabled, null, { timeout: 30000 });
        const dl = await download(page, id, 900000);
        const t0 = Date.now();
        const a = await ask(page, "What is the invoice total?", 900000);
        const answerMs = Date.now() - t0;
        if (!a.pages.includes(14)) throw new Error(`cited ${a.pages}: ${a.text}`);
        if (!/1,?234\.50/.test(a.text)) throw new Error(a.text);
        return `download ${dl} ms, first answer (with load) ${answerMs} ms: ${a.text.slice(0, 80)}`;
      });
    }
    await test("large model: summary written by the model", async () => {
      await open(page, "/en/summarize-pdf");
      await pick(page, ["report.pdf"]);
      await row(page, "large").getByRole("radio").waitFor({ timeout: 10000 });
      await page.getByRole("button", { name: t["tool.summarize.action"], exact: true }).click();
      await page.locator("[data-summary]").waitFor({ timeout: 600000 });
      const note = await page.getByText(t["res.summaryModel"]).count();
      if (!note) throw new Error("not written by the model");
      return (await page.locator("[data-summary]").innerText()).slice(0, 100);
    });
    await test("large model: report.pdf into Spanish, same page count", async () => {
      await open(page, "/en/translate-pdf");
      await pick(page, ["report.pdf"]);
      await row(page, "large").getByRole("radio").waitFor({ timeout: 10000 });
      await page.getByRole("button", { name: t["tool.translate.action"], exact: true }).click();
      const dl = await page.waitForEvent("download", { timeout: 900000 });
      const path = join(dir, dl.suggestedFilename());
      await dl.saveAs(path);
      const out = await PDFDocument.load(readFileSync(path));
      const src = await PDFDocument.load(readFileSync(new URL("../fixtures/report.pdf", import.meta.url)));
      if (out.getPageCount() !== src.getPageCount()) throw new Error(`${out.getPageCount()} pages, expected ${src.getPageCount()}`);
      const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
      const pdf = await getDocument({ data: new Uint8Array(readFileSync(path)), verbosity: 0 }).promise;
      let text = "";
      for (let i = 1; i <= pdf.numPages; i++) text += (await (await pdf.getPage(i)).getTextContent()).items.map((x) => x.str).join(" ") + " ";
      const spanish = (text.toLowerCase().match(/\b(el|la|los|las|de|del|que|y|en|por|para|con|ingresos|trimestre)\b/g) ?? []).length;
      if (spanish < 10) throw new Error(`not Spanish: ${text.slice(0, 200)}`);
      if (process.env.DEBUG_AI) console.log(text);
      return `${out.getPageCount()} pages, ${spanish} Spanish function words: ${text.slice(0, 80)}`;
    });
  }

  await test("no request leaves the site", async () => {
    if (away.length) throw new Error(away.slice(0, 3).join(", "));
    return `all same-origin (${modelFiles.length} model part requests)`;
  });
  await ctx.close();
});
