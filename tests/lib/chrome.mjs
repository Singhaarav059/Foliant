// The Chrome that browser-based engine tests drive: CHROME_PATH, Playwright's
// own Chromium (npx playwright-core install chromium), or an installed Google
// Chrome. Without one the test is skipped, except in CI, where it fails so a
// missing browser can't pass for a green run.
import pw from "playwright-core";
import { existsSync } from "node:fs";

export function requireChrome() {
  const chrome = [
    process.env.CHROME_PATH,
    pw.chromium.executablePath(),
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
  ].find((p) => p && existsSync(p));
  if (!chrome) {
    console.log(`${process.env.CI ? "FAIL" : "skip"}  no Chrome found (set CHROME_PATH or run npx playwright-core install chromium)`);
    process.exit(process.env.CI ? 1 : 0);
  }
  return chrome;
}
