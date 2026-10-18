// "Open with" and the phone share sheet: files shared to the installed app
// (a multipart POST to /share, answered by the service worker) or opened
// with it (window.launchQueue) land on /{lang}/open, which hands them to the
// tool picked. Works offline, and nothing is requested from other domains.
//
//   node tests/e2e/share.mjs [chromium] [firefox] [webkit]   (see kit.mjs)
import { readFileSync } from "node:fs";
import { base, dict, fixture, suite } from "./kit.mjs";

const t = dict("en");
const PDF = "report.pdf";
const origin = new URL(base).origin;

// Polls an async check in the page (waitForFunction doesn't await promises).
async function until(page, fn, arg, what, timeout = 30000) {
  for (const end = Date.now() + timeout; Date.now() < end; await page.waitForTimeout(250)) {
    if (await page.evaluate(fn, arg).catch(() => false)) return;
  }
  throw new Error(`timed out waiting for ${what}`);
}

const controlled = (page) => until(page, () => !!navigator.serviceWorker.controller, null, "the service worker");

// What a share sheet does: a form POST of the files to the manifest's
// share_target, as a navigation, so the service worker answers it.
async function share(page, names) {
  await page.evaluate(() => {
    const form = document.createElement("form");
    form.method = "post";
    form.enctype = "multipart/form-data";
    form.action = "/share";
    form.innerHTML = '<input type="hidden" name="title" value="Shared"><input type="file" name="files" multiple>';
    form.id = "share-form";
    document.body.append(form);
  });
  await page.locator("#share-form input[type=file]").setInputFiles(names.map(fixture));
  await Promise.all([page.waitForURL("**/open**", { timeout: 20000 }), page.evaluate(() => document.getElementById("share-form").submit())]);
}

// The open page has hydrated and lists these files.
async function listed(page, names) {
  const list = page.getByRole("list", { name: t["open.files"] });
  for (const n of names) await list.getByText(n, { exact: true }).waitFor({ timeout: 20000 });
}

// The tool's workspace holds the file.
const inTool = (page, name) => page.locator("main").getByText(name, { exact: true }).first().waitFor({ timeout: 20000 });

const pickTool = (page, toolId) => page.getByRole("link", { name: t[`tool.${toolId}.name`], exact: true }).click();

async function context(browser, locale = "en-US") {
  const ctx = await browser.newContext({ locale });
  const foreign = [];
  ctx.on("request", (r) => {
    const u = new URL(r.url());
    if (/^https?:$/.test(u.protocol) && u.origin !== origin) foreign.push(u.href);
  });
  return { ctx, foreign };
}

const noForeign = (foreign) => {
  if (foreign.length) throw new Error(`requested other domains: ${[...new Set(foreign)].slice(0, 3).join(", ")}`);
};

await suite(async ({ name, browser, test }) => {
  if (name === "chromium") {
    await test("the manifest declares share_target and file_handlers", async () => {
      const { ctx } = await context(browser);
      const page = await ctx.newPage();
      try {
        await page.goto(base + "/en");
        const cdp = await ctx.newCDPSession(page);
        // What DevTools' Application panel shows: the manifest Chrome fetched, and its parse errors.
        const { errors, data } = await cdp.send("Page.getAppManifest", {});
        if (errors.length) throw new Error(errors.map((e) => e.message).join("; "));
        const manifest = JSON.parse(data);
        const st = manifest.share_target;
        if (st?.action !== "/share" || st.method !== "POST" || st.enctype !== "multipart/form-data") throw new Error(`share_target: ${JSON.stringify(st)}`);
        const fh = manifest.file_handlers;
        if (!fh?.[0]?.action.endsWith("/open") || !fh[0].accept["application/pdf"]) throw new Error(`file_handlers: ${JSON.stringify(fh)}`);
        return "share_target POST /share, file_handlers → /en/open, no manifest errors";
      } finally {
        await ctx.close();
      }
    });
  }

  await test("a PDF shared online lands in the tool picked", async () => {
    const { ctx, foreign } = await context(browser);
    const page = await ctx.newPage();
    try {
      await page.goto(base + "/en");
      await controlled(page);
      await share(page, [PDF]);
      if (!new URL(page.url()).pathname.startsWith("/en/open")) throw new Error(`landed on ${page.url()}`);
      await listed(page, [PDF]);
      await pickTool(page, "compress");
      await page.waitForURL("**/en/compress-pdf");
      await inTool(page, PDF);
      noForeign(foreign);
      return "POST /share → 303 /en/open → Compress PDF holds report.pdf";
    } finally {
      await ctx.close();
    }
  });

  await test("offline: sharing still opens the picker and the tool", async () => {
    const { ctx, foreign } = await context(browser);
    const page = await ctx.newPage();
    try {
      await page.goto(base + "/en");
      await controlled(page);
      // A tool visited once is kept for offline use, like any page.
      await page.goto(base + "/en/merge-pdf");
      await until(page, () => caches.match("/en/merge-pdf").then(Boolean), null, "the tool page to be cached");
      await until(page, () => caches.match("/en/open").then(Boolean), null, "/en/open to be cached");
      await ctx.setOffline(true);
      const reaches = await page.evaluate(() => fetch(`/icon.svg?probe=${Math.random()}`).then(() => false, () => true));
      if (!reaches) return "skipped: setOffline doesn't reach the service worker here";
      await share(page, [PDF, "report-v2.pdf"]);
      await listed(page, [PDF, "report-v2.pdf"]);
      // Marks this document: gone if the tool's page loads afresh.
      await page.evaluate(() => (window.__sameDocument = true));
      await pickTool(page, "merge");
      await page.waitForURL("**/en/merge-pdf");
      await inTool(page, "report-v2.pdf");
      await inTool(page, PDF);
      const how = (await page.evaluate(() => window.__sameDocument === true)) ? "in memory" : "from storage, after a page load";
      noForeign(foreign);
      return `offline POST /share → /en/open → Merge PDF holds both files (${how})`;
    } finally {
      await ctx.close();
    }
  });

  // An installed app opened from a PDF ("Open with"): Chrome hands the file
  // to the page through window.launchQueue, mocked here.
  const launch = (page, names) =>
    page.addInitScript((files) => {
      const handles = files.map(({ name, bytes }) => ({
        kind: "file",
        name,
        getFile: async () => new File([new Uint8Array(bytes)], name, { type: "application/pdf" }),
      }));
      // Chrome has a real, read-only launchQueue (empty when not launched).
      const queue = { setConsumer: (consumer) => setTimeout(() => consumer({ files: handles, targetURL: location.href }), 50) };
      Object.defineProperty(window, "launchQueue", { value: queue, configurable: true });
    }, names.map((n) => ({ name: n, bytes: [...readFileSync(fixture(n))] })));

  await test("Open with: a launched PDF lands on /en/open", async () => {
    const { ctx, foreign } = await context(browser);
    const page = await ctx.newPage();
    try {
      await launch(page, [PDF]);
      await page.goto(base + "/en/open");
      await listed(page, [PDF]);
      await pickTool(page, "split");
      await page.waitForURL("**/en/split-pdf");
      await inTool(page, PDF);
      noForeign(foreign);
      return "launchQueue file → /en/open → Split PDF";
    } finally {
      await ctx.close();
    }
  });

  await test("Open with: the file follows the language used last", async () => {
    const { ctx } = await context(browser, "fr-FR");
    const page = await ctx.newPage();
    try {
      await page.goto(base + "/fr");
      await until(page, () => localStorage.getItem("locale") === "fr", null, "the language to be remembered");
      await launch(page, [PDF]);
      await page.goto(base + "/en/open");
      await page.waitForURL("**/fr/open**");
      const fr = dict("fr");
      await page.getByRole("list", { name: fr["open.files"] }).getByText(PDF, { exact: true }).waitFor({ timeout: 20000 });
      return "/en/open → /fr/open with the file";
    } finally {
      await ctx.close();
    }
  });

  await test("/en/open with no files offers to choose some", async () => {
    const { ctx } = await context(browser);
    const page = await ctx.newPage();
    try {
      await page.goto(base + "/en/open");
      await page.getByText(t["open.empty"].split("{brand}")[1]).waitFor({ timeout: 20000 });
      await page.waitForFunction(() => {
        const input = document.querySelector("main input[type=file]");
        return !!input && Object.keys(input).some((k) => k.startsWith("__reactProps"));
      }, null, { timeout: 20000 });
      await page.locator("main input[type=file]").setInputFiles(fixture("brief.docx"));
      await listed(page, ["brief.docx"]);
      await page.getByRole("link", { name: t["tool.wordToPdf.name"], exact: true }).waitFor();
      const links = await page.getByRole("list", { name: t["open.tools"] }).getByRole("link").count();
      return `a docx is offered ${links} tool(s)`;
    } finally {
      await ctx.close();
    }
  });
});
