// Shared setup for the end-to-end specs in this folder. They run against the
// static build in real browsers, like tests/e2e.mjs:
//
//   npm run build:static
//   node scripts/serve-static.mjs out 3202 &
//   node tests/e2e/<spec>.mjs [chromium] [firefox] [webkit]
//
// BASE_URL changes the server (default http://localhost:3202). CHROME_PATH
// runs the chromium specs in an installed Chrome instead of Playwright's.
import pw from "playwright-core";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
export const fixtures = join(root, "tests/fixtures");
export const base = process.env.BASE_URL ?? "http://localhost:3202";
const engines = process.argv.slice(2).length ? process.argv.slice(2) : ["chromium", "firefox", "webkit"];

export const launch = (name) =>
  pw[name].launch(name === "chromium" && process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});

// A language's strings, English filling the gaps (as on the site).
const parse = (lang) => {
  const out = {};
  const src = readFileSync(join(root, "src/lib/i18n/dict", `${lang}.ts`), "utf8");
  for (const m of src.matchAll(/^\s*"([^"]+)":\s*"((?:[^"\\]|\\.)*)",?\s*$/gm)) out[m[1]] = JSON.parse(`"${m[2]}"`);
  return out;
};
export const dict = (lang) => ({ ...parse("en"), ...parse(lang) });
export const languages = () => readdirSync(join(root, "src/lib/i18n/dict")).map((f) => f.replace(/\.ts$/, ""));

// Static pages are plain HTML until React hydrates. Wait for the workspace's
// file input (inside a Suspense boundary) as well as the header.
export async function open(page, path, options = {}) {
  await page.goto(base + path, { waitUntil: "load", ...options });
  await page.waitForFunction(() => {
    const hydrated = (el) => Object.keys(el).some((k) => k.startsWith("__reactProps"));
    const input = document.querySelector("input[type=file]");
    return [...document.querySelectorAll("button")].some(hydrated) && (!input || hydrated(input));
  }, null, { timeout: 20000 });
}

export const fixture = (f) => (f.startsWith("/") ? f : join(fixtures, f));
export const pick = (page, files) => page.locator("input[type=file]").first().setInputFiles(files.map(fixture));

// Runs `body` once per browser and prints a PASS/FAIL table, like tests/e2e.mjs.
export async function suite(body) {
  const results = [];
  for (const name of engines) {
    let browser;
    try {
      browser = await launch(name);
    } catch (e) {
      results.push({ browser: name, label: "launch", ok: false, ms: 0, detail: e.message.split("\n")[0] });
      continue;
    }
    const test = async (label, fn) => {
      const t0 = Date.now();
      try {
        results.push({ browser: name, label, ok: true, detail: (await fn()) ?? "" });
      } catch (e) {
        results.push({ browser: name, label, ok: false, detail: e.message.split("\n")[0].slice(0, 200) });
      }
      results.at(-1).ms = Date.now() - t0;
    };
    try {
      await body({ name, browser, test });
    } finally {
      await browser.close();
    }
  }
  for (const r of results) {
    console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.browser.padEnd(9)} ${r.label.padEnd(44)} ${`${r.ms}ms`.padStart(8)}  ${r.detail}`);
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
}
