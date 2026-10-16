import "server-only";
import { existsSync } from "node:fs";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { Browser, Page } from "playwright-core";

const CANDIDATES = [
  process.env.CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
].filter(Boolean) as string[];

export function chromePath() {
  return CANDIDATES.find((p) => existsSync(p)) ?? null;
}

let browser: Promise<Browser> | null = null;

async function getBrowser() {
  const path = chromePath();
  if (!path) throw new Error("Chrome or Chromium isn't installed on the server. Set CHROME_PATH.");
  browser ??= import("playwright-core").then(({ chromium }) =>
    chromium.launch({ executablePath: path, headless: true, args: ["--disable-dev-shm-usage"] }),
  );
  const b = await browser;
  if (!b.isConnected()) {
    browser = null;
    return getBrowser();
  }
  return b;
}

// ── Blocking private addresses, so a submitted URL can't reach the server's own network.
function privateV4(ip: string) {
  const [a, b] = ip.split(".").map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}

function privateIp(ip: string) {
  if (isIP(ip) === 4) return privateV4(ip);
  const v = ip.toLowerCase();
  if (v.startsWith("::ffff:")) return privateV4(v.slice(7));
  return v === "::1" || v === "::" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe8") || v.startsWith("fe9") || v.startsWith("fea") || v.startsWith("feb");
}

export async function publicHost(hostname: string) {
  if (/^localhost$|\.local$|\.internal$/i.test(hostname)) return false;
  if (isIP(hostname)) return !privateIp(hostname);
  try {
    const addrs = await lookup(hostname, { all: true });
    return addrs.length > 0 && addrs.every((a) => !privateIp(a.address));
  } catch {
    return false;
  }
}

const OVERLAY_CLEANUP = `
(() => {
  const words = /(cookie|consent|gdpr|onetrust|didomi|usercentrics|cmp|newsletter|subscribe|paywall|modal|popup|overlay|banner)/i;
  const vw = innerWidth, vh = innerHeight;
  for (const el of document.querySelectorAll("body *")) {
    const cs = getComputedStyle(el);
    if (cs.position !== "fixed" && cs.position !== "sticky") continue;
    const r = el.getBoundingClientRect();
    const big = r.width * r.height > vw * vh * 0.25;
    const tag = (el.id + " " + el.className + " " + (el.getAttribute("aria-label") || "")).toString();
    if (words.test(tag) || big || el.getAttribute("aria-modal") === "true") el.remove();
    else if (cs.position === "fixed") el.style.position = "absolute";
  }
  document.documentElement.style.overflow = "auto";
  document.body.style.overflow = "auto";
})();
`;

export type PrintOptions = { pageSize: string; orientation: string; screenWidth: number; hideOverlays: boolean };

async function guard(page: Page) {
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.protocol === "data:" || url.protocol === "blob:") return route.continue();
    if (!/^https?:$/.test(url.protocol) || !(await publicHost(url.hostname))) return route.abort("blockedbyclient");
    return route.continue();
  });
}

export async function printToPdf(source: { url?: string; html?: string }, o: PrintOptions): Promise<Uint8Array> {
  const b = await getBrowser();
  const context = await b.newContext({
    viewport: { width: o.screenWidth, height: 900 },
    deviceScaleFactor: 1,
    javaScriptEnabled: true,
    acceptDownloads: false,
    serviceWorkers: "block",
  });
  const page = await context.newPage();
  try {
    await guard(page);
    if (source.url) {
      await page.goto(source.url, { waitUntil: "load", timeout: 45_000 });
      await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => {});
    } else {
      await page.setContent(source.html ?? "", { waitUntil: "load", timeout: 30_000 });
    }
    // Trigger lazy-loaded images by scrolling through once.
    await page.evaluate(async () => {
      const step = innerHeight;
      for (let y = 0; y < document.body.scrollHeight; y += step) {
        scrollTo(0, y);
        await new Promise((r) => setTimeout(r, 120));
      }
      scrollTo(0, 0);
    });
    if (o.hideOverlays) await page.evaluate(OVERLAY_CLEANUP);
    await page.emulateMedia({ media: "screen" });
    if (o.pageSize === "single") {
      const height = await page.evaluate(() => Math.max(document.body.scrollHeight, document.documentElement.scrollHeight));
      return await page.pdf({
        width: `${o.screenWidth}px`, height: `${Math.min(height + 2, 200_000)}px`, printBackground: true, pageRanges: "1",
      });
    }
    return await page.pdf({
      format: o.pageSize === "letter" ? "Letter" : "A4",
      landscape: o.orientation === "landscape",
      printBackground: true,
      margin: { top: "12mm", bottom: "12mm", left: "10mm", right: "10mm" },
    });
  } finally {
    await context.close();
  }
}

// Prints HTML we generated ourselves (office conversions, translations). CSS @page decides size.
export async function htmlToPdf(html: string): Promise<Uint8Array> {
  const b = await getBrowser();
  const context = await b.newContext({ javaScriptEnabled: false, serviceWorkers: "block" });
  const page = await context.newPage();
  try {
    await guard(page);
    await page.setContent(html, { waitUntil: "load", timeout: 60_000 });
    return await page.pdf({ preferCSSPageSize: true, printBackground: true });
  } finally {
    await context.close();
  }
}

// Runs a function inside a blank Chrome page, used for parsing XML with the browser's DOMParser.
export async function inBrowser<T, A>(fn: (arg: A) => T | Promise<T>, arg: A): Promise<T> {
  const b = await getBrowser();
  const context = await b.newContext({ serviceWorkers: "block" });
  const page = await context.newPage();
  try {
    await page.route("**/*", (r) => r.abort());
    return (await page.evaluate(fn as never, arg as never)) as T;
  } finally {
    await context.close();
  }
}
