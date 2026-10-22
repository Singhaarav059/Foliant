// End-to-end tests of the static build in real browsers.
//
//   npm run build:static
//   node scripts/serve-static.mjs out 3202 &
//   npx playwright-core install chromium firefox webkit
//   node tests/e2e.mjs [chromium] [firefox] [webkit]
//
// BASE_URL changes the server (default http://localhost:3202). CHROME_PATH
// runs the chromium tests in an installed Chrome instead of Playwright's.
//
// More tests live in tests/e2e/*.mjs, one file per area. A file that
// default-exports a named function gets this file's helpers (test, open,
// pick, run, …) and runs once per browser, after the tests below. The other
// files there are standalone suites with their own npm run test:e2e:* script.
import pw from "playwright-core";
import { PDFDocument } from "pdf-lib";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Paths below start with "/", so a pasted address ending in "/" would double it.
const base = (process.env.BASE_URL ?? "http://localhost:3202").replace(/\/+$/, "");
const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const specDir = join(dirname(fileURLToPath(import.meta.url)), "e2e");
// Only files that default-export a spec. The others there are standalone
// suites (node tests/e2e/<area>.mjs) or their shared kit, which run on import.
const specs = await Promise.all(readdirSync(specDir).filter((f) => f.endsWith(".mjs") && /^export default /m.test(readFileSync(join(specDir, f), "utf8"))).sort().map((f) => import(pathToFileURL(join(specDir, f)).href)));
const downloads = mkdtempSync(join(tmpdir(), "e2e-"));
const engines = process.argv.slice(2).length ? process.argv.slice(2) : ["chromium", "firefox", "webkit"];
const results = [];

const pdfInfo = async (path) => {
  try {
    return { pages: (await PDFDocument.load(readFileSync(path))).getPageCount(), encrypted: false };
  } catch (e) {
    return { pages: null, encrypted: /encrypt/i.test(e.message) };
  }
};
const isZip = (path) => { const b = readFileSync(path); return b[0] === 0x50 && b[1] === 0x4b; };

for (const name of engines) {
  let browser;
  try {
    browser = await pw[name].launch(name === "chromium" && process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
  } catch (e) {
    results.push({ browser: name, label: "launch", ok: false, ms: 0, detail: e.message.split("\n")[0] });
    continue;
  }
  const ctx = await browser.newContext({ acceptDownloads: true, locale: "en-US", viewport: { width: 1280, height: 900 } });
  // Everything the site needs is served from its own origin. Block and record
  // anything else, so a tool that still reaches for a CDN fails its test.
  const foreign = new Set();
  await ctx.route((url) => url.origin !== new URL(base).origin && !url.protocol.startsWith("blob") && !url.protocol.startsWith("data"), (route) => {
    foreign.add(new URL(route.request().url()).host);
    return route.abort();
  });
  const page = await ctx.newPage();

  const test = async (label, fn) => {
    const t0 = Date.now();
    try {
      results.push({ browser: name, label, ok: true, ms: Date.now() - t0, detail: await fn() });
    } catch (e) {
      results.push({ browser: name, label, ok: false, ms: Date.now() - t0, detail: e.message.split("\n")[0].slice(0, 200) });
    }
    results.at(-1).ms = Date.now() - t0;
  };
  // Pages are static HTML; wait until React has hydrated before using them.
  // The tool workspace hydrates after the header (it's inside a Suspense
  // boundary), and a file picked before its input is hydrated is never seen.
  const open = async (path) => {
    await page.goto(base + path, { waitUntil: "load" });
    await page.waitForFunction(() => {
      const hydrated = (el) => Object.keys(el).some((k) => k.startsWith("__reactProps"));
      const input = document.querySelector("input[type=file]");
      return [...document.querySelectorAll("button")].some(hydrated) && (!input || hydrated(input));
    }, null, { timeout: 20000 });
  };
  const pick = (files) => page.locator("input[type=file]").first().setInputFiles(files.map((f) => (f.startsWith("/") ? f : join(fixtures, f))));
  const save = async (dl) => {
    const path = join(downloads, `${name}-${dl.suggestedFilename()}`);
    await dl.saveAs(path);
    return path;
  };
  // A single result downloads by itself.
  const run = async (button, timeout = 60000) => {
    const [dl] = await Promise.all([page.waitForEvent("download", { timeout }), page.getByRole("button", { name: button, exact: true }).click()]);
    return save(dl);
  };
  // Several results wait for "Download all (ZIP)".
  const runMany = async (button) => {
    await page.getByRole("button", { name: button, exact: true }).click();
    const zip = page.getByRole("button", { name: /Download all/ });
    await zip.waitFor({ timeout: 60000 });
    const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 60000 }), zip.click()]);
    const path = await save(dl);
    if (!isZip(path)) throw new Error("not a ZIP");
    return `${await page.locator("main ul li").count()} files zipped`;
  };

  await test("language redirect", async () => {
    const c = await browser.newContext({ locale: "fr-FR" });
    const p = await c.newPage();
    await p.goto(base + "/");
    await p.waitForURL(/\/fr$/, { timeout: 10000 });
    await c.close();
    return "/ → /fr";
  });

  // GitHub Pages answers every missing path with /404.html, the language
  // picker. It must stay out of search results once React has hydrated it,
  // not only in its HTML.
  await test("site-wide 404 is noindex", async () => {
    const c = await browser.newContext();
    const p = await c.newPage();
    await p.route("**/en/no-such-page", async (route) => route.fulfill({ response: await route.fetch({ url: base + "/404.html" }), status: 404 }));
    await p.goto(base + "/en/no-such-page", { waitUntil: "networkidle" });
    await p.waitForFunction(() => [...document.querySelectorAll("a")].some((a) => Object.keys(a).some((k) => k.startsWith("__react"))), null, { timeout: 20000 });
    const head = await p.evaluate(() => ({
      canonical: document.querySelectorAll("link[rel=canonical]").length,
      hreflang: document.querySelectorAll("link[rel=alternate][hreflang]").length,
      robots: [...document.querySelectorAll("meta[name=robots]")].map((m) => m.content).join(),
    }));
    await c.close();
    if (head.canonical || head.hreflang || !/noindex/.test(head.robots)) throw new Error(JSON.stringify(head));
    return "noindex, no canonical or translations";
  });

  // Tools have addresses in each language's words; the old English ones
  // redirect (_redirects), or refresh where a host ignores _redirects.
  await test("old address redirects to the localized one", async () => {
    await open("/es/merge-pdf");
    if (!page.url().endsWith("/es/unir-pdf")) throw new Error(`at ${page.url()}`);
    return "/es/merge-pdf → /es/unir-pdf";
  });

  await test("old address refreshes without _redirects", async () => {
    const c = await browser.newContext();
    const p = await c.newPage();
    await p.route("**/de/compress-pdf", (route) => route.fulfill({ contentType: "text/html", body: readFileSync(join(fixtures, "../../out/de/compress-pdf.html"), "utf8") }));
    await p.goto(base + "/de/compress-pdf");
    await p.waitForURL("**/de/pdf-komprimieren", { timeout: 10000 });
    await c.close();
    return "/de/compress-pdf → /de/pdf-komprimieren";
  });

  await test("switching language keeps the tool", async () => {
    await open("/en/merge-pdf");
    await page.getByRole("button", { name: "Language" }).click();
    await page.locator('header a[hreflang="de"]').click();
    await page.waitForURL("**/de/pdf-zusammenfuegen", { timeout: 10000 });
    const h1 = await page.locator("h1").textContent();
    if (h1 !== "PDF zusammenfügen") throw new Error(`h1 ${h1}`);
    return "/en/merge-pdf → /de/pdf-zusammenfuegen";
  });

  // The language menu is links, one per translation, to the same addresses
  // the page's <link rel=alternate hreflang> tags give.
  await test("language menu links match hreflang", async () => {
    await open("/es/unir-pdf");
    await page.getByRole("button", { name: "Idioma" }).click();
    const { links, alternates } = await page.evaluate(() => ({
      links: [...document.querySelectorAll("header a[hreflang]")].map((a) => `${a.hreflang}=${a.getAttribute("href")}|${a.lang}`),
      alternates: [...document.querySelectorAll("link[rel=alternate][hreflang]")].filter((l) => l.hreflang !== "x-default").map((l) => `${l.hreflang}=${new URL(l.href).pathname}|${l.hreflang}`),
    }));
    // One per dictionary (src/lib/i18n/dict).
    const langs = readdirSync(join(fixtures, "../../src/lib/i18n/dict")).filter((f) => f.endsWith(".ts")).length;
    if (links.length !== langs || links.sort().join() !== alternates.sort().join()) throw new Error(`${links.length} links, e.g. ${links.find((l) => !alternates.includes(l))}`);
    return `${langs} links, same as hreflang`;
  });

  await test("intent page links to the tools in its language", async () => {
    await open("/fr/convertisseur-pdf");
    await page.locator('main a[href="/fr/pdf-en-word"]').first().click();
    await page.waitForURL("**/fr/pdf-en-word", { timeout: 10000 });
    return "/fr/convertisseur-pdf → /fr/pdf-en-word";
  });

  // Every tool declared in src/lib/tools.ts.
  const toolCount = (readFileSync(join(fixtures, "../../src/lib/tools.ts"), "utf8").match(/^\s+id: "\w+", slug: "/gm) ?? []).length;
  await test(`home lists ${toolCount} tools`, async () => {
    await open("/en");
    const n = await page.locator("main a[data-tool]").count();
    const over = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    if (n !== toolCount || over > 0) throw new Error(`${n} tools, ${over}px overflow`);
    return `${n} tools`;
  });

  await test("merge", async () => {
    await open("/en/merge-pdf");
    await pick(["report.pdf", "report-v2.pdf"]);
    const { pages } = await pdfInfo(await run("Merge PDFs"));
    const expected = (await pdfInfo(join(fixtures, "report.pdf"))).pages + (await pdfInfo(join(fixtures, "report-v2.pdf"))).pages;
    if (pages !== expected) throw new Error(`${pages} pages, expected ${expected}`);
    return `${pages} pages`;
  });

  await test("compress", async () => {
    await open("/en/compress-pdf");
    await pick(["scanned.pdf"]);
    const { pages } = await pdfInfo(await run("Compress PDF"));
    if (!pages) throw new Error("invalid PDF");
    return "valid PDF";
  });

  await test("split", async () => {
    await open("/en/split-pdf");
    await pick(["report.pdf"]);
    return runMany("Split PDF");
  });

  await test("PDF to JPG", async () => {
    await open("/en/pdf-to-jpg");
    await pick(["report.pdf"]);
    return runMany("Convert to images");
  });

  await test("page numbers", async () => {
    await open("/en/add-page-numbers");
    await pick(["report.pdf"]);
    const { pages } = await pdfInfo(await run("Add page numbers"));
    if (!pages) throw new Error("invalid PDF");
    return `${pages} pages`;
  });

  let locked = null;
  await test("protect", async () => {
    await open("/en/protect-pdf");
    await pick(["report.pdf"]);
    await page.getByLabel("Password", { exact: true }).fill("test1234");
    await page.getByLabel("Repeat password", { exact: true }).fill("test1234");
    const path = await run("Protect PDF");
    if (!(await pdfInfo(path)).encrypted) throw new Error("not encrypted");
    locked = path;
    return "encrypted";
  });

  await test("unlock", async () => {
    if (!locked) throw new Error("protect failed");
    await open("/en/unlock-pdf");
    await pick([locked]);
    await page.getByLabel("Password", { exact: true }).fill("test1234");
    const info = await pdfInfo(await run("Unlock PDF"));
    if (info.encrypted || !info.pages) throw new Error("still encrypted");
    return "decrypted";
  });

  await test("OCR", async () => {
    await open("/en/ocr-pdf");
    await pick(["scanned.pdf"]);
    const path = await run("Run OCR", 180000);
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const doc = await pdfjs.getDocument({ data: new Uint8Array(readFileSync(path)) }).promise;
    const text = (await (await doc.getPage(1)).getTextContent()).items.map((x) => x.str).join(" ").replace(/\s+/g, " ");
    if (!/invoice 4471/i.test(text)) throw new Error(`text was "${text.slice(0, 60)}"`);
    return `"${text.trim().slice(0, 40)}"`;
  });

  await test("every OCR language is bundled", async () => {
    const langs = readFileSync(join(fixtures, "../../src/lib/tools.ts"), "utf8").match(/OCR_LANGS = \[([^\]]+)\]/)[1].match(/[a-z_]+/g);
    const vendor = readFileSync(join(fixtures, "../../src/lib/vendor.ts"), "utf8").match(/VENDOR = "([^"]+)"/)[1];
    const missing = await page.evaluate(async ([ls, vendor]) => {
      const res = await Promise.all(ls.map((l) => fetch(`${vendor}tessdata/${l}.traineddata.gz`, { method: "HEAD" }).then((r) => (r.ok ? null : l))));
      return res.filter(Boolean);
    }, [langs, vendor]);
    if (missing.length) throw new Error(`missing: ${missing.join(", ")}`);
    return `${langs.length} languages`;
  });

  // Non-Latin watermarks are embedded as real, extractable text in bundled fonts.
  for (const [lang, mark] of [["Hindi", "गोपनीय"], ["Chinese", "机密文件"], ["Japanese", "社外秘です"], ["Russian", "Секретно"], ["Thai", "ความลับ"], ["Arabic", "سري"]]) {
    await test(`${lang} watermark is text`, async () => {
      await open("/en/add-watermark");
      await pick(["report.pdf"]);
      await page.getByLabel("Text", { exact: true }).fill(mark);
      const path = await run("Add watermark");
      const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
      const doc = await pdfjs.getDocument({ data: new Uint8Array(readFileSync(path)) }).promise;
      const text = (await (await doc.getPage(1)).getTextContent()).items.map((x) => x.str).join("");
      const chars = [...mark].filter((c) => /\p{L}/u.test(c));
      // Arabic is stored in its joined presentation forms, so only count letters.
      const found = lang === "Arabic" ? /[\u0600-\u06ff\ufe70-\ufeff]/.test(text) : chars.every((c) => text.includes(c));
      if (!found) throw new Error(`text layer was "${text.slice(-40)}"`);
      return "selectable text";
    });
  }

  await test("rotate shows page thumbnails", async () => {
    await open("/en/rotate-pdf");
    await pick(["report.pdf"]);
    await page.waitForFunction(() => [...document.querySelectorAll("img")].some((i) => i.src.startsWith("blob:") && i.naturalWidth > 0), null, { timeout: 30000 });
    await run("Rotate PDF");
    return "thumbnails, rotated PDF";
  });

  for (const [slug, file, needle] of [["word-to-pdf", "brief.docx", "Project brief"], ["powerpoint-to-pdf", "plan.pptx", "Launch plan"], ["excel-to-pdf", "budget.xlsx", "Hosting"]]) {
    await test(`${file} Standard: a PDF file, no print dialog`, async () => {
      await open(`/en/${slug}`);
      await pick([file]);
      // Automatic makes a real PDF with LibreOffice (tests/e2e-office.mjs); Standard draws one in the page.
      await page.getByRole("radio", { name: /^Standard/ }).click();
      const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
      const doc = await pdfjs.getDocument({ data: new Uint8Array(readFileSync(await run("Convert to PDF"))) }).promise;
      let text = "";
      for (let i = 1; i <= doc.numPages; i++) text += (await (await doc.getPage(i)).getTextContent()).items.map((x) => x.str).join("");
      if (!text.includes(needle)) throw new Error(`text was "${text.slice(0, 60)}"`);
      return `${doc.numPages} pages, "${needle}" found`;
    });
  }

  await test("workflow: compress → page numbers", async () => {
    await open("/en/workflows");
    await page.getByRole("button", { name: /Compress PDF/ }).first().click();
    await page.getByRole("button", { name: /Add page numbers/ }).first().click();
    await pick(["report.pdf"]);
    const { pages } = await pdfInfo(await run("Run"));
    if (!pages) throw new Error("invalid PDF");
    return `${pages} pages`;
  });

  await test("Arabic is right-to-left", async () => {
    await open("/ar/merge-pdf");
    const dir = await page.evaluate(() => document.documentElement.dir);
    if (dir !== "rtl") throw new Error(dir);
    return dir;
  });

  await test("offline service worker", async () => {
    await open("/en");
    const vendor = readFileSync(join(fixtures, "../../src/lib/vendor.ts"), "utf8").match(/VENDOR_VERSION = "([^"]+)"/)[1];
    const { state, script, cachesNow } = await page.evaluate(async () => {
      const reg = await Promise.race([navigator.serviceWorker.ready, new Promise((r) => setTimeout(() => r(null), 10000))]);
      return { state: reg?.active?.state ?? "not ready", script: reg?.active?.scriptURL ?? "", cachesNow: await caches.keys() };
    });
    if (state !== "activated") throw new Error(state);
    // A new vendor version must mean a new worker and cache, or new pages
    // could run against an old pdf.js worker or qpdf.wasm.
    if (!script.endsWith(`?v=${vendor}`) || cachesNow.join() !== `nopload-${vendor}`) throw new Error(`${script} ${cachesNow.join()}`);
    return `activated, cache nopload-${vendor}`;
  });

  // Firefox has no mobile emulation.
  if (name !== "firefox") {
    await test("phone layout and menu", async () => {
      const c = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });
      const p = await c.newPage();
      await p.goto(base + "/en/compress-pdf");
      const over = await p.evaluate(() => document.documentElement.scrollWidth - innerWidth);
      await p.getByRole("button", { name: "Menu" }).tap();
      await p.getByRole("dialog").waitFor({ timeout: 5000 });
      await c.close();
      if (over > 0) throw new Error(`${over}px overflow`);
      return "fits, menu opens";
    });
  }

  for (const spec of specs) await spec.default({ name, browser, page, base, fixtures, test, open, pick, save, run, runMany, pdfInfo, isZip });

  // Only on a page left alone: navigating mid-load cancels prefetches,
  // which some engines log as errors.
  await test("no console errors", async () => {
    const c = await browser.newContext();
    const p = await c.newPage();
    const errors = [];
    p.on("pageerror", (e) => errors.push(e.message.slice(0, 160)));
    p.on("console", (m) => m.type() === "error" && errors.push(m.text().slice(0, 160)));
    await p.goto(base + "/en");
    await p.waitForTimeout(5000);
    await p.goto(base + "/en/merge-pdf");
    await p.waitForTimeout(4000);
    await c.close();
    if (errors.length) throw new Error(errors.join(" ; "));
    return "none";
  });

  await test("no third-party requests", async () => {
    if (foreign.size) throw new Error([...foreign].join(", "));
    return "none";
  });

  await browser.close();
}

for (const r of results) {
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.browser.padEnd(9)} ${r.label.padEnd(34)} ${`${r.ms}ms`.padStart(8)}  ${r.detail}`);
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
