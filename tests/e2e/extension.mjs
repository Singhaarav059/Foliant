// The browser add-on (extension/) loaded unpacked in Chromium, against the
// static build: "Open in Nopload" downloads the PDF in the add-on, opens the
// site and hands the file to the page, and the next tool starts with it.
//
//   npm run build:static
//   node tests/e2e/extension.mjs
//
// It serves out/ on port 3710 itself (unless something already answers
// there) and the PDFs it opens on 3711. Browser menus can't be clicked from
// a test, so it calls the menu's handler in the add-on's service worker.
// Chrome-branded builds no longer load unpacked add-ons from the command
// line, so this runs Playwright's Chromium, or CHROME_PATH if that is a
// Chromium or Chrome for Testing.
import pw from "playwright-core";
import { join } from "node:path";
import { checksum, fail, FILES, ok, report, requireBrowser, setup, SITE, t, test } from "./extension-kit.mjs";

const chromium = requireBrowser(process.env.CHROME_PATH || pw.chromium.executablePath(), "Playwright's Chromium isn't installed (npx playwright-core install chromium)");
const { temp, ext, hits, big } = await setup();

let ctx;
try {
  ctx = await pw.chromium.launchPersistentContext(join(temp, "profile"), {
    executablePath: chromium,
    channel: "chromium", // full Chromium in new headless mode, which runs add-ons
    headless: true,
    locale: "en-US",
    viewport: { width: 1280, height: 900 },
    args: [`--disable-extensions-except=${join(ext, "chrome")}`, `--load-extension=${join(ext, "chrome")}`],
  });
  const worker = ctx.serviceWorkers().find((w) => w.url().startsWith("chrome-extension://")) ?? (await ctx.waitForEvent("serviceworker", { timeout: 15000 }));
  const extOrigin = worker.url().split("/").slice(0, 3).join("/"); // URL.origin is "null" for chrome-extension:
  // What each page was handed, as a checksum, read back by the tests.
  await ctx.addInitScript(() =>
    addEventListener("message", (e) => {
      if (e.data?.source !== "nopload-extension" || e.data.type !== "files") return;
      const b = new Uint8Array(e.data.files[0].data);
      let sum = 0;
      for (let i = 0; i < b.length; i++) sum = (sum * 33 + b[i]) >>> 0;
      window.__handed = { size: b.length, sum };
    }),
  );
  const start = await ctx.newPage();
  await start.goto(`${FILES}/`);

  // Runs "Open in Nopload" on a URL, as the menu does from `start`'s tab, and
  // returns the tab it opens.
  async function openIn(url) {
    const tab = await worker.evaluate(() => chrome.tabs.query({ active: true, lastFocusedWindow: true }).then(([t]) => t));
    const opened = ctx.waitForEvent("page", { timeout: 15000 });
    await worker.evaluate(([url, tab]) => globalThis.openInNopload(url, { after: tab }), [url, tab]);
    const page = await opened;
    await page.waitForLoadState("load");
    return page;
  }
  const bar = (page) => page.locator("[data-extension-file]");

  await test("a PDF link opens the tool picker with the file", async () => {
    const page = await openIn(`${FILES}/files/report.pdf`);
    await bar(page).waitFor({ timeout: 20000 });
    const text = await bar(page).innerText();
    ok(text.includes(t["handoff.pick"].replace("{name}", "report.pdf")), `bar says "${text}"`);
    const url = new URL(page.url());
    ok(url.origin === SITE && url.pathname === "/en" && !url.hash, `landed on ${page.url()}`);
    ok((await page.locator("[data-tool]").count()) > 10, "no tool grid");
    await page.close();
  });

  await test("the next tool starts with the file", async () => {
    const page = await openIn(`${FILES}/files/report.pdf`);
    await bar(page).waitFor({ timeout: 20000 });
    await page.locator('[data-tool="compress"]').click();
    await page.locator(`button[aria-label="${t["ws.remove"]} report.pdf"]`).waitFor({ timeout: 20000 });
    ok((await bar(page).count()) === 0, "the bar stayed after picking a tool");
    await page.close();
  });

  await test("a tool that doesn't take PDFs starts empty", async () => {
    const page = await openIn(`${FILES}/files/report.pdf`);
    await bar(page).waitFor({ timeout: 20000 });
    await page.locator('[data-tool="wordToPdf"]').click();
    await page.locator("input[type=file]").first().waitFor({ state: "attached", timeout: 20000 });
    await page.waitForTimeout(500);
    ok((await page.locator(`button[aria-label^="${t["ws.remove"]} "]`).count()) === 0, "the PDF was put in Word to PDF");
    await page.close();
  });

  await test("the file name comes from Content-Disposition", async () => {
    const page = await openIn(`${FILES}/download?id=7`);
    await bar(page).waitFor({ timeout: 20000 });
    const text = await bar(page).innerText();
    ok(text.includes("Annual report 2026.pdf"), `bar says "${text}"`);
    await page.close();
  });

  await test("a 4 MB file arrives byte for byte", async () => {
    const page = await openIn(`${FILES}/files/big.pdf`);
    await bar(page).waitFor({ timeout: 20000 });
    const got = await page.evaluate(() => window.__handed);
    ok(got?.size === big.length && got.sum === checksum(big), `got ${JSON.stringify(got)}, sent ${big.length} bytes`);
    await page.close();
  });

  await test("the site downloaded nothing; the add-on fetched each file once", async () => {
    const expected = ["/", "/files/report.pdf", "/files/report.pdf", "/files/report.pdf", "/download?id=7", "/files/big.pdf"];
    ok(JSON.stringify(hits) === JSON.stringify(expected), `requests: ${JSON.stringify(hits)}`);
  });

  await test("a file that isn't a PDF says so", async () => {
    const page = await openIn(`${FILES}/files/fake.pdf`);
    ok(page.url().startsWith(`${extOrigin}/open.html`), `opened ${page.url()}`);
    await page.getByText("This isn't a PDF").waitFor({ timeout: 5000 });
    await page.close();
  });

  await test("a missing file names the error", async () => {
    const page = await openIn(`${FILES}/files/gone.pdf`);
    await page.getByText("error 404").waitFor({ timeout: 5000 });
    await page.close();
  });

  await test("a site not yet allowed asks first, for that site only", async () => {
    const before = hits.length;
    const page = await openIn("http://localhost:3711/files/report.pdf");
    ok(page.url().startsWith(`${extOrigin}/open.html`), `opened ${page.url()}`);
    await page.getByRole("button", { name: "Allow and open" }).waitFor({ timeout: 5000 });
    ok((await page.locator("#text").innerText()).includes("localhost"), "doesn't name the site");
    ok(hits.length === before, "fetched before asking");
    // Once allowed, open.html asks the add-on to go on, in the same tab.
    await page.evaluate(() => chrome.runtime.sendMessage({ type: "open", url: "http://127.0.0.1:3711/files/report.pdf" }));
    await page.waitForURL(`${SITE}/en`, { timeout: 20000 });
    await bar(page).waitFor({ timeout: 20000 });
    await page.close();
  });

  await test("a non-web address isn't fetched", async () => {
    const page = await openIn("file:///etc/hosts");
    await page.getByText("This can't be opened").waitFor({ timeout: 5000 });
    await page.close();
  });

  await test("a normal visit shows no bar", async () => {
    const page = await ctx.newPage();
    await page.goto(`${SITE}/en`);
    await page.locator("[data-tool]").first().waitFor();
    await page.waitForTimeout(1000);
    ok((await bar(page).count()) === 0, "a bar without a file");
    await page.close();
  });
} catch (e) {
  fail("launch", e);
} finally {
  await ctx?.close();
}
report("chromium");
