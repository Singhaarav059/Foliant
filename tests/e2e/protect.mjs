// Protect PDF in real browsers: a password that looks like a command-line
// option works, and one too long for a PDF is refused with a clear message,
// on the tool page and in a workflow, before any file is made.
//
//   npm run build:static
//   node scripts/serve-static.mjs out 3202 &
//   node tests/e2e/protect.mjs [chromium] [firefox] [webkit]
//
// BASE_URL and CHROME_PATH work as in tests/e2e.mjs.
import pw from "playwright-core";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const base = process.env.BASE_URL ?? "http://localhost:3202";
const fixtures = join(dirname(fileURLToPath(import.meta.url)), "../fixtures");
const downloads = mkdtempSync(join(tmpdir(), "e2e-protect-"));
const engines = process.argv.slice(2).length ? process.argv.slice(2) : ["chromium", "firefox", "webkit"];
const results = [];
const LONG = "a".repeat(200);
const TOO_LONG = "That password is too long for a PDF. Use 127 characters or fewer.";

// Opens with pdf.js: the page count, or the error's name.
async function opens(path, password) {
  try {
    const pdf = await getDocument({ data: new Uint8Array(readFileSync(path)), password, verbosity: 0 }).promise;
    const n = pdf.numPages;
    await pdf.loadingTask.destroy();
    return n;
  } catch (e) {
    return e.name;
  }
}

for (const name of engines) {
  let browser;
  try {
    browser = await pw[name].launch(name === "chromium" && process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
  } catch (e) {
    results.push({ browser: name, label: "launch", ok: false, detail: e.message.split("\n")[0] });
    continue;
  }
  const ctx = await browser.newContext({ acceptDownloads: true, locale: "en-US", viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  let downloaded = 0;
  page.on("download", () => downloaded++);
  const test = async (label, fn) => {
    try {
      results.push({ browser: name, label, ok: true, detail: await fn() });
    } catch (e) {
      results.push({ browser: name, label, ok: false, detail: e.message.split("\n")[0].slice(0, 200) });
    }
  };
  const open = async (path) => {
    await page.goto(base + path, { waitUntil: "load" });
    // Hydrated, including the file input: a file set before React listens is lost.
    await page.waitForFunction(() => {
      const live = (el) => !!el && Object.keys(el).some((k) => k.startsWith("__reactProps"));
      return live(document.querySelector("input[type=file]")) && [...document.querySelectorAll("button")].some(live);
    }, null, { timeout: 20000 });
  };
  const fill = async (password) => {
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByLabel("Repeat password", { exact: true }).fill(password);
  };
  // The alert's text once it appears, with no download in the meantime.
  const refused = async (button) => {
    const before = downloaded;
    await page.getByRole("button", { name: button, exact: true }).first().click();
    // Inside main: Next.js keeps a route announcer with role=alert of its own.
    const alert = page.locator("main [role=alert]");
    await alert.waitFor({ timeout: 10000 });
    await page.waitForTimeout(500);
    if (downloaded !== before) throw new Error("a file was downloaded");
    return (await alert.textContent()).trim();
  };

  for (const password of ["@Secure2024", "-v"]) {
    await test(`password ${password} protects the file`, async () => {
      await open("/en/protect-pdf");
      await page.locator("input[type=file]").first().setInputFiles(join(fixtures, "report.pdf"));
      await fill(password);
      const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 60000 }), page.getByRole("button", { name: "Protect PDF", exact: true }).click()]);
      const path = join(downloads, `${name}-${Date.now()}-${dl.suggestedFilename()}`);
      await dl.saveAs(path);
      const withIt = await opens(path, password), without = await opens(path);
      if (withIt !== 3 || without !== "PasswordException") throw new Error(`with the password: ${withIt}, without: ${without}`);
      return "opens with it, not without";
    });
  }

  await test("a 200-character password is refused on the tool page", async () => {
    await open("/en/protect-pdf");
    await page.locator("input[type=file]").first().setInputFiles(join(fixtures, "report.pdf"));
    await fill(LONG);
    const text = await refused("Protect PDF");
    if (text !== TOO_LONG) throw new Error(`alert was "${text}"`);
    return text;
  });

  await test("a 200-character password is refused in a workflow", async () => {
    await open("/en/workflows");
    await page.getByRole("button", { name: /Protect PDF/ }).first().click();
    await fill(LONG);
    await page.locator("input[type=file]").first().setInputFiles(join(fixtures, "report.pdf"));
    const text = await refused("Run");
    if (text !== TOO_LONG) throw new Error(`alert was "${text}"`);
    return text;
  });

  await browser.close();
}

for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.browser.padEnd(9)} ${r.label.padEnd(50)} ${r.detail}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
