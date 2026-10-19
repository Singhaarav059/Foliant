// Offline: after one visit to a tool, loaded directly or reached by a link,
// the page loads and the tool runs with no network. Info pages don't
// download the PDF engines.
//
//   node tests/e2e/offline.mjs [chromium] [firefox] [webkit]   (see kit.mjs)
import { PDFDocument } from "pdf-lib";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { base, dict, fixture, suite } from "./kit.mjs";
import { corpus } from "../lib/corpus.mjs";

const vendor = readFileSync(fixture("../../src/lib/vendor.ts"), "utf8").match(/VENDOR = "([^"]+)"/)[1];
const downloads = mkdtempSync(join(tmpdir(), "offline-"));

// Every URL the service worker has cached, as paths.
const cached = (page) =>
  page.evaluate(async () => {
    const out = [];
    for (const name of await caches.keys()) for (const req of await (await caches.open(name)).keys()) out.push(new URL(req.url).pathname);
    return out;
  });

// Polls an async check in the page (waitForFunction doesn't await promises).
async function until(page, fn, arg, what, timeout = 30000) {
  for (const end = Date.now() + timeout; Date.now() < end; await page.waitForTimeout(250)) {
    if (await page.evaluate(fn, arg)) return;
  }
  throw new Error(`timed out waiting for ${what}`);
}

// A service worker controls the page (it claims open pages when it activates).
const controlled = (page) => until(page, () => !!navigator.serviceWorker.controller, null, "the service worker");

// Whether a request the service worker passes to the network fails, i.e.
// setOffline applies to the worker too.
const swOffline = (page) =>
  page.evaluate(() => fetch(`/icon.svg?probe=${Math.random()}`).then(() => false, () => true));

const hydrated = (page) =>
  page.waitForFunction(() => {
    const input = document.querySelector("input[type=file]");
    return !!input && Object.keys(input).some((k) => k.startsWith("__reactProps"));
  }, null, { timeout: 20000 });

await suite(async ({ name, browser, test }) => {
  await test("an info page doesn't download the engines", async () => {
    const ctx = await browser.newContext({ locale: "en-US" });
    const page = await ctx.newPage();
    const requested = [];
    ctx.on("request", (r) => requested.push(new URL(r.url()).pathname));
    await page.goto(base + "/en/about");
    await controlled(page);
    await page.waitForTimeout(1500);
    const all = [...requested, ...(await cached(page))];
    await ctx.close();
    const engines = all.filter((p) => /qpdf\.wasm|pdf\.worker|pdfium\.wasm|mozjpeg/.test(p));
    if (engines.length) throw new Error(`fetched ${[...new Set(engines)].join(", ")}`);
    return "no qpdf.wasm, no pdf.js worker";
  });

  // Reaching the tool from the home page by a link is a client-side
  // navigation: the browser never requests the tool's page itself.
  const reach = {
    "after one visit": (page) => page.goto(base + "/fr/compresser-pdf"),
    "reached by a link": async (page) => {
      await page.locator('a[href="/fr/compresser-pdf"]').first().click();
      await page.waitForURL("**/fr/compresser-pdf");
    },
  };
  for (const [how, go] of Object.entries(reach)) {
    await test(`fr: compress works offline ${how}`, async () => {
      const t = dict("fr");
      const ctx = await browser.newContext({ locale: "fr-FR", viewport: { width: 1280, height: 900 } });
      const page = await ctx.newPage();
      try {
        await page.goto(base + "/fr");
        await controlled(page);
        await go(page);
        await hydrated(page);
        // The tool's engines are fetched once the page settles.
        await until(page, async (wasm) => {
          for (const name of await caches.keys()) if (await (await caches.open(name)).match(wasm)) return true;
          return false;
        }, `${vendor}qpdf.wasm`, "the engines to be cached");
        // A page reached by a link is loaded once more in a hidden frame,
        // which is removed when it has cached what a reload needs.
        await until(page, async () => !document.querySelector("iframe") && !!(await caches.match(location.pathname)),
          null, "the page itself to be cached", 60000);
        // Settled: nothing new cached for a second. (Not "networkidle": the
        // removed frame's requests are never reported as finished.)
        let paths = await cached(page);
        for (let before = -1; before !== paths.length; ) {
          before = paths.length;
          await page.waitForTimeout(1000);
          paths = await cached(page);
        }
        const chunks = paths.filter((p) => p.startsWith("/_next/static/chunks/"));
        if (!chunks.length) throw new Error("no /_next/static/chunks/ entry in the cache");

        await ctx.setOffline(true);
        const really = await swOffline(page);
        // Offline emulation also stops the download of the result, so keep
        // the PDFs the page makes and read the last one back.
        await page.addInitScript(() => {
          const create = URL.createObjectURL;
          window.__pdfs = [];
          URL.createObjectURL = (blob) => {
            if (blob instanceof Blob && blob.type === "application/pdf") window.__pdfs.push(blob);
            return create.call(URL, blob);
          };
        });
        await page.reload({ waitUntil: "load" });
        await hydrated(page);
        await page.locator("input[type=file]").first().setInputFiles(fixture("scanned.pdf"));
        await page.getByRole("button", { name: t["tool.compress.action"], exact: true }).click();
        await page.getByText(t["res.doneTitle"]).waitFor({ timeout: 60000 });
        const bytes = await page.evaluate(async () => [...new Uint8Array(await window.__pdfs.at(-1).arrayBuffer())]);
        const path = join(downloads, `${name}-${how.replace(/\W+/g, "-")}-compressed.pdf`);
        writeFileSync(path, Buffer.from(bytes));
        const pages = (await PDFDocument.load(readFileSync(path))).getPageCount();
        if (!pages) throw new Error("not a valid PDF");
        return `${chunks.length} chunks cached, offline output has ${pages} page(s)${really ? "" : " (setOffline doesn't reach the service worker here)"}`;
      } finally {
        await ctx.close();
      }
    });
  }

  // Every PDF tool opens files through qpdf, so offline it must have qpdf's
  // code too: without it pdf-lib refuses a file with only an owner password.
  await test("en: watermark opens an owner-password file offline", async () => {
    const t = dict("en");
    const owner = join(downloads, "owner.pdf");
    writeFileSync(owner, corpus(["enc-aes256-owner.pdf"])["enc-aes256-owner.pdf"]);
    const ctx = await browser.newContext({ locale: "en-US", viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    try {
      await page.goto(base + "/en/add-watermark");
      await controlled(page);
      await hydrated(page);
      await until(page, async () => !document.querySelector("iframe") && !!(await caches.match(location.pathname)),
        null, "the page itself to be cached", 60000);
      let paths = await cached(page);
      for (let before = -1; before !== paths.length; ) {
        before = paths.length;
        await page.waitForTimeout(1000);
        paths = await cached(page);
      }
      await ctx.setOffline(true);
      if (!(await swOffline(page))) return "skipped: setOffline doesn't reach the service worker here";
      await page.reload({ waitUntil: "load" });
      await hydrated(page);
      await page.locator("input[type=file]").first().setInputFiles(owner);
      await page.getByRole("button", { name: t["tool.watermark.action"], exact: true }).click();
      await page.getByText(t["res.doneTitle"]).waitFor({ timeout: 60000 });
      return "watermarked offline";
    } finally {
      await ctx.close();
    }
  });

  await test("an unvisited page offline falls back to its language's home", async () => {
    const ctx = await browser.newContext({ locale: "de-DE" });
    const page = await ctx.newPage();
    try {
      await page.goto(base + "/de");
      await controlled(page);
      await ctx.setOffline(true);
      // Some engines don't take the service worker offline with the page.
      if (!(await swOffline(page))) return "skipped: setOffline doesn't reach the service worker here";
      let navigations = 0;
      page.on("framenavigated", (f) => f === page.mainFrame() && navigations++);
      const res = await page.goto(base + "/de/pdf-teilen", { waitUntil: "commit" });
      const html = await res.text();
      if (!/<html[^>]*lang="de"/.test(html)) throw new Error(`served ${html.match(/<html[^>]*>/)?.[0] ?? "nothing"}`);
      await page.waitForTimeout(2000);
      if (navigations > 2) throw new Error(`${navigations} navigations: reload loop`);
      return "served /de";
    } finally {
      await ctx.close();
    }
  });
});
