import "server-only";
import { existsSync } from "node:fs";
import type { Browser, Page } from "playwright-core";
import { BLOCKED_HEADER, startEgressProxy } from "./egress";
import { HttpError } from "./errors";
import { allowedScheme, publicHost } from "./net";
import { limiter, withDeadline } from "./run";

export { publicHost };

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

// One Chrome for the process, launched with the egress proxy as its only way
// out: it never resolves a host name itself (--host-resolver-rules), WebRTC
// can't open its own UDP sockets, and the proxy checks every destination.
let browser: Promise<Browser> | null = null;
let proxy: ReturnType<typeof startEgressProxy> | null = null;

async function getBrowser(): Promise<Browser> {
  const path = chromePath();
  if (!path) throw new HttpError(503, "Conversions that need Chrome aren't available on this server.");
  proxy ??= startEgressProxy();
  const { port } = await proxy;
  browser ??= import("playwright-core").then(({ chromium }) =>
    chromium.launch({
      executablePath: path,
      headless: true,
      // Playwright adds --proxy-bypass-list=<-loopback>, so localhost isn't exempt.
      proxy: { server: `http://127.0.0.1:${port}` },
      args: [
        "--disable-dev-shm-usage",
        "--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1",
        "--webrtc-ip-handling-policy=disable_non_proxied_udp",
        "--force-webrtc-ip-handling-policy",
        "--disable-background-networking",
        "--js-flags=--max-old-space-size=512",
      ],
    }),
  );
  const b = await browser.catch((e) => {
    browser = null;
    throw e;
  });
  if (!b.isConnected()) {
    browser = null;
    return getBrowser();
  }
  return b;
}

// MAX_CHROME_JOBS pages at a time (default 2) and eight waiting; past that
// the server answers busy. Each page also has a hard deadline.
const gate = limiter(Number(process.env.MAX_CHROME_JOBS ?? 2), 8);

// A first check in the page; the egress proxy is what enforces it.
async function guard(page: Page) {
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (!allowedScheme(url)) return route.abort("blockedbyclient");
    if (url.protocol === "data:" || url.protocol === "blob:") return route.continue();
    if (!(await publicHost(url.hostname))) return route.abort("blockedbyclient");
    return route.continue();
  });
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

export const printToPdf = (source: { url?: string; html?: string }, o: PrintOptions) => gate(() => print(source, o));

async function print(source: { url?: string; html?: string }, o: PrintOptions): Promise<Uint8Array> {
  const b = await getBrowser();
  const context = await b.newContext({
    viewport: { width: o.screenWidth, height: 900 },
    deviceScaleFactor: 1,
    javaScriptEnabled: true,
    acceptDownloads: false,
    serviceWorkers: "block",
  });
  const page = await context.newPage();
  const job = async () => {
    await guard(page);
    if (source.url) {
      const res = await page.goto(source.url, { waitUntil: "load", timeout: 45_000 });
      if (res?.headers()[BLOCKED_HEADER]) throw new HttpError(400, "That address isn't reachable from the public internet.");
      await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => {});
    } else {
      await page.setContent(source.html ?? "", { waitUntil: "load", timeout: 30_000 });
    }
    // Trigger lazy-loaded images by scrolling through once, for at most 60
    // screens or 10 seconds, since an endless feed never reaches the bottom.
    await page.evaluate(async () => {
      const step = innerHeight;
      const until = Date.now() + 10_000;
      for (let y = 0, n = 0; y < document.body.scrollHeight && n < 60 && Date.now() < until; y += step, n++) {
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
  };
  return withDeadline(job(), 100_000, () => context.close()).finally(() => context.close().catch(() => {}));
}

// Prints HTML we generated ourselves (office conversions, translations). CSS @page decides size.
export const htmlToPdf = (html: string) =>
  gate(async (): Promise<Uint8Array> => {
    const b = await getBrowser();
    const context = await b.newContext({ javaScriptEnabled: false, serviceWorkers: "block" });
    const page = await context.newPage();
    const job = async () => {
      await guard(page);
      await page.setContent(html, { waitUntil: "load", timeout: 60_000 });
      return await page.pdf({ preferCSSPageSize: true, printBackground: true });
    };
    return withDeadline(job(), 90_000, () => context.close()).finally(() => context.close().catch(() => {}));
  });

// Runs a function inside a blank Chrome page, used for parsing XML with the
// browser's DOMParser. It has no network at all. Not gated: it runs while an
// office conversion prepares the HTML it then hands to htmlToPdf.
export async function inBrowser<T, A>(fn: (arg: A) => T | Promise<T>, arg: A): Promise<T> {
  const b = await getBrowser();
  const context = await b.newContext({ serviceWorkers: "block" });
  const page = await context.newPage();
  const job = async () => {
    await page.route("**/*", (r) => r.abort());
    return (await page.evaluate(fn as never, arg as never)) as T;
  };
  return withDeadline(job(), 60_000, () => context.close()).finally(() => context.close().catch(() => {}));
}
