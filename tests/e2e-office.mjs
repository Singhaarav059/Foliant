// Word, PowerPoint and Excel → PDF in the static build make a real PDF file
// with the default options, on a host that sends no isolation headers and in
// a browser that has never seen the site: the first conversion asks once for
// the LibreOffice download, reloads the page by itself to become
// cross-origin isolated, and picks the job up again. Desktop Chromium by
// default; BROWSER=webkit or firefox tries another engine.
//
//   npm run build:static
//   node tests/e2e-office.mjs [dir=out]
//
// The test serves the build itself, without the headers in out/_headers, the
// way GitHub Pages would (PORT, default 3203). BASE_URL tests a running site
// instead. CHROME_PATH runs an installed Chrome instead of Playwright's Chromium.
import pw from "playwright-core";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const downloads = mkdtempSync(join(tmpdir(), "e2e-office-"));
let failed = 0;

// /a → a.html or a/index.html, as scripts/serve-static.mjs and Cloudflare Pages resolve it.
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".wasm": "application/wasm", ".woff2": "font/woff2", ".png": "image/png" };
let server = null;
let base = process.env.BASE_URL;
if (!base) {
  const dir = resolve(process.argv[2] ?? join(here, "../out"));
  if (!existsSync(join(dir, "en"))) throw new Error(`no static build in ${dir}: run npm run build:static`);
  const isFile = (p) => existsSync(p) && statSync(p).isFile();
  server = createServer((req, res) => {
    const target = join(dir, decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname));
    const file = target.startsWith(dir) && [target, `${target}.html`, join(target, "index.html")].find(isFile);
    if (!file) return res.writeHead(404).end();
    res.writeHead(200, { "Content-Type": types[extname(file)] ?? "application/octet-stream" }).end(readFileSync(file));
  });
  const port = Number(process.env.PORT ?? 3203);
  await new Promise((ok) => server.listen(port, ok));
  base = `http://localhost:${port}`;
}

const engine = process.env.BROWSER ?? "chromium";
const browser = await pw[engine].launch(engine === "chromium" && process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
// A new context is a fresh profile: no service worker, no stored consent, no cached LibreOffice.
const ctx = await browser.newContext({ acceptDownloads: true, locale: "en-US", viewport: { width: 1280, height: 900 } });
const page = await ctx.newPage();
const alerts = [];
page.on("dialog", (d) => { alerts.push(d.message()); d.dismiss(); });
let loads = 0;
page.on("load", () => loads++);

const test = async (label, fn) => {
  const t0 = Date.now();
  try {
    const detail = await fn();
    console.log(`ok    ${label} (${Math.round((Date.now() - t0) / 1000)} s): ${detail}`);
  } catch (e) {
    failed++;
    console.log(`FAIL  ${label}: ${e.message.split("\n")[0].slice(0, 300)}`);
  }
};
const hydrated = () => page.waitForFunction(() => {
  const input = document.querySelector("input[type=file]");
  return input && Object.keys(input).some((k) => k.startsWith("__reactProps"));
}, null, { timeout: 30000 });
const open = async (path) => {
  await page.goto(base + path, { waitUntil: "load" });
  await hydrated();
};
// The text of a PDF, as pdf.js reads it, and the program that wrote it.
async function pdfText(path) {
  const bytes = new Uint8Array(readFileSync(path));
  if (Buffer.from(bytes.subarray(0, 5)).toString("latin1") !== "%PDF-") throw new Error(`not a PDF: starts with ${JSON.stringify(Buffer.from(bytes.subarray(0, 8)).toString("latin1"))}`);
  const doc = await getDocument({ data: bytes, verbosity: 0 }).promise;
  let text = "";
  for (let i = 1; i <= doc.numPages; i++) text += (await (await doc.getPage(i)).getTextContent()).items.map((t) => t.str).join(" ") + "\n";
  return { text, producer: String((await doc.getMetadata()).info?.Producer ?? "") };
}
// Waits for the result to download, failing at once if an error message or a
// print preview shows instead.
async function download(trigger, timeout) {
  // Not Next's route announcer, which reads out the page title after navigating.
  const alert = page.locator("[role=alert]:not(#__next-route-announcer__)").filter({ hasText: /\S/ }).first();
  const error = alert.waitFor({ timeout }).then(async () => { throw new Error(`alert: ${await alert.innerText()}`); });
  const preview = page.locator("iframe").first().waitFor({ timeout }).then(() => { throw new Error("a print preview instead of a PDF file"); });
  // Still pending when the download wins.
  error.catch(() => {});
  preview.catch(() => {});
  const [dl] = await Promise.race([Promise.all([page.waitForEvent("download", { timeout }), trigger()]), error, preview]);
  const path = join(downloads, dl.suggestedFilename());
  await dl.saveAs(path);
  return path;
}

await test("Word → PDF on a first visit: one consent, a real PDF", async () => {
  await open("/en/word-to-pdf");
  // Without the headers the page starts out not isolated, so the job has to go through the reload.
  const isolatedAtFirst = await page.evaluate(() => crossOriginIsolated);
  await page.locator("input[type=file]").first().setInputFiles(join(here, "fixtures/brief.docx"));
  const before = loads;
  const path = await download(async () => {
    await page.getByRole("button", { name: "Convert to PDF", exact: true }).click();
    await page.getByRole("button", { name: "Download and convert", exact: true }).click({ timeout: 15000 });
  }, 300000);
  if (!/\.pdf$/.test(path)) throw new Error(`downloaded ${path}`);
  const { text, producer } = await pdfText(path);
  if (!text.includes("Project brief")) throw new Error(`text was ${JSON.stringify(text.slice(0, 80))}`);
  if (!/LibreOffice/.test(producer)) throw new Error(`written by ${producer}`);
  if (alerts.length) throw new Error(`alert: ${alerts.join(" | ")}`);
  const reloads = loads - before;
  if (!isolatedAtFirst && reloads !== 1) throw new Error(`${reloads} reloads, expected 1`);
  return `isolated at first ${isolatedAtFirst}, ${reloads} reload, "Project brief" found, written by ${producer}`;
});

await test("the PDF continues into another tool", async () => {
  await page.getByRole("link", { name: "Compress PDF" }).click();
  await page.waitForURL(/\/en\/compress-pdf/);
  await page.getByText("brief.pdf").first().waitFor({ timeout: 15000 });
  const path = await download(() => page.getByRole("button", { name: "Compress PDF", exact: true }).click(), 60000);
  const { text } = await pdfText(path);
  if (!text.includes("Project brief")) throw new Error("compressed PDF lost its text");
  return "compressed";
});

await test("Excel → PDF afterwards: one click, no questions", async () => {
  await open("/en/excel-to-pdf");
  await page.locator("input[type=file]").first().setInputFiles(join(here, "fixtures/budget.xlsx"));
  const path = await download(() => page.getByRole("button", { name: "Convert to PDF", exact: true }).click(), 300000);
  const { text, producer } = await pdfText(path);
  if (!text.includes("Hosting")) throw new Error(`text was ${JSON.stringify(text.slice(0, 80))}`);
  if (!/LibreOffice/.test(producer)) throw new Error(`written by ${producer}`);
  return '"Hosting" found';
});

await browser.close();
server?.close();
process.exit(failed ? 1 : 0);
