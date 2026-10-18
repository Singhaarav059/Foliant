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
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dict, fixture, root } from "./kit.mjs";

const SITE = "http://127.0.0.1:3710";
const FILES = "http://127.0.0.1:3711";
const t = dict("en");

if (!existsSync(join(root, "out/en.html")) && !existsSync(join(root, "out/en/index.html"))) {
  console.log("FAIL  no static build in out/ (run npm run build:static)");
  process.exit(1);
}
const chromium = process.env.CHROME_PATH || pw.chromium.executablePath();
if (!existsSync(chromium)) {
  console.log(`${process.env.CI ? "FAIL" : "skip"}  Playwright's Chromium isn't installed (npx playwright-core install chromium)`);
  process.exit(process.env.CI ? 1 : 0);
}

const temp = mkdtempSync(join(tmpdir(), "nopload-ext-e2e-"));
const cleanup = [() => rmSync(temp, { recursive: true, force: true })];

// The add-on for this site, allowed to read 127.0.0.1 without asking (a test
// can't answer the permission prompt). Files on "localhost" still need asking.
const ext = join(temp, "build");
const built = spawnSync(process.execPath, [join(root, "scripts/build-extension.mjs"), "--out", ext, "--test-host", "http://127.0.0.1/*"], {
  env: { ...process.env, NOPLOAD_RELEASE: "", NOPLOAD_EXTENSION_SITE_URL: SITE },
  encoding: "utf8",
});
if (built.status !== 0) {
  console.log(`FAIL  build: ${built.stdout}${built.stderr}`);
  process.exit(1);
}

// The static build, unless already served.
const up = await fetch(`${SITE}/en`).then((r) => r.ok, () => false);
if (!up) {
  const server = spawn(process.execPath, [join(root, "scripts/serve-static.mjs"), join(root, "out"), "3710"], { stdio: "ignore" });
  cleanup.push(() => server.kill());
  for (let i = 0; i < 50 && !(await fetch(`${SITE}/en`).then((r) => r.ok, () => false)); i++) await new Promise((r) => setTimeout(r, 200));
}

// Another site with PDFs, and a log of what was asked of it.
const hits = [];
const pdf = readFileSync(fixture("report.pdf"));
// Several of the add-on's 1 MiB message pieces, with bytes that differ.
const big = Buffer.concat([pdf, Buffer.from(Array.from({ length: 3.5 * 1024 * 1024 }, (_, i) => (i * 31 + 7) & 255))]);
const files = createServer((req, res) => {
  if (req.url !== "/favicon.ico") hits.push(req.url);
  if (req.url === "/files/report.pdf") return res.writeHead(200, { "content-type": "application/pdf" }).end(pdf);
  if (req.url === "/files/big.pdf") return res.writeHead(200, { "content-type": "application/pdf" }).end(big);
  if (req.url.startsWith("/download"))
    return res.writeHead(200, { "content-type": "application/octet-stream", "content-disposition": `attachment; filename="x.bin"; filename*=UTF-8''Annual%20report%202026` }).end(pdf);
  if (req.url === "/files/fake.pdf") return res.writeHead(200, { "content-type": "application/pdf" }).end("<html>Sign in</html>");
  if (req.url === "/files/gone.pdf") return res.writeHead(404).end();
  if (req.url === "/") return res.writeHead(200, { "content-type": "text/html" }).end('<a href="/files/report.pdf">Report</a>');
  res.writeHead(404).end();
});
await new Promise((r) => files.listen(3711, "127.0.0.1", r));
cleanup.push(() => files.close());

const results = [];
const test = async (label, fn) => {
  const t0 = Date.now();
  try {
    results.push({ label, ok: true, detail: (await fn()) ?? "" });
  } catch (e) {
    results.push({ label, ok: false, detail: e.message.split("\n")[0].slice(0, 200) });
  }
  results.at(-1).ms = Date.now() - t0;
};
const ok = (cond, what) => {
  if (!cond) throw new Error(what);
};

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
  const checksum = (b) => b.reduce((sum, x) => (sum * 33 + x) >>> 0, 0);
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
  results.push({ label: "launch", ok: false, ms: 0, detail: e.message.split("\n")[0] });
} finally {
  await ctx?.close();
  for (const f of cleanup) f();
}

for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  chromium  ${r.label.padEnd(58)} ${`${r.ms}ms`.padStart(8)}  ${r.detail}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
