// Privacy the browser enforces: every page carries a Content-Security-Policy
// (a header from out/_headers, and a <meta> copy for hosts that can't send
// headers) that stops requests to other sites, and the privacy chip on tool
// pages shows, live, what left the device.
//
//   node tests/e2e/csp.mjs [chromium] [firefox] [webkit]   (see kit.mjs)
import { readFileSync } from "node:fs";
import { base, fixture, open, pick, suite } from "./kit.mjs";

const PROBE = "https://example.com/nopload-csp-probe";
const VENDOR = readFileSync(fixture("../../src/lib/vendor.ts"), "utf8").match(/VENDOR = "([^"]+)"/)[1];

// The chip's counters, from its data attributes.
const chip = (page) =>
  page.locator("[data-privacy-chip]").first().evaluate((el) => ({
    sent: Number(el.dataset.sent),
    offsite: Number(el.dataset.offsite),
    blocked: Number(el.dataset.blocked),
    text: el.textContent,
  }));

// Polls the chip until `ok` holds.
async function chipUntil(page, ok, what, timeout = 15000) {
  let last;
  for (const end = Date.now() + timeout; Date.now() < end; await page.waitForTimeout(200)) {
    last = await chip(page);
    if (ok(last)) return last;
  }
  throw new Error(`chip never showed ${what}: ${JSON.stringify(last)}`);
}

// Answers requests to example.com with a permissive 200, so a request the
// policy failed to stop would succeed instead of failing for another reason.
async function fakeOtherSite(ctx) {
  const hits = [];
  await ctx.route("https://example.com/**", (route) => {
    hits.push(route.request().url());
    return route.fulfill({ status: 200, body: "reached", headers: { "access-control-allow-origin": "*", "cross-origin-resource-policy": "cross-origin" } });
  });
  return hits;
}

// Tries a fetch, an image and a script from another origin; reports how each
// ended and the violations the page saw.
const probe = (page) =>
  page.evaluate(async (url) => {
    const violations = [];
    document.addEventListener("securitypolicyviolation", (e) => violations.push(`${e.effectiveDirective} ${e.blockedURI}`));
    const fetched = await fetch(url, { mode: "cors" }).then((r) => `status ${r.status}`, () => "failed");
    const load = (tag, attr) =>
      new Promise((resolve) => {
        const el = document.createElement(tag);
        el.onload = () => resolve("loaded");
        el.onerror = () => resolve("failed");
        el[attr] = `${url}?${tag}`;
        document.body.append(el);
        setTimeout(() => resolve("timeout"), 5000);
      });
    const image = await load("img", "src");
    const script = await load("script", "src");
    await new Promise((r) => setTimeout(r, 300));
    return { fetched, image, script, violations };
  }, PROBE);

function expectBlocked(result, hits) {
  if (result.fetched !== "failed" || result.image !== "failed" || result.script !== "failed") throw new Error(`not blocked: ${JSON.stringify(result)}`);
  if (hits.length) throw new Error(`reached the network: ${hits.join(", ")}`);
  const dirs = result.violations.map((v) => v.split(" ")[0]);
  for (const d of ["connect-src", "img-src", "script-src-elem"]) {
    if (!dirs.includes(d)) throw new Error(`no ${d} violation: ${JSON.stringify(result.violations)}`);
  }
  return `fetch, img and script blocked (${result.violations.length} violations)`;
}

await suite(async ({ browser, test }) => {
  await test("tool pages send the policy as a header and a meta tag", async () => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    try {
      const res = await page.goto(base + "/en/compress-pdf");
      const header = (await res.allHeaders())["content-security-policy"] ?? "";
      for (const d of ["default-src 'self'", "connect-src 'self' blob: data:", "frame-ancestors 'self'", "object-src 'none'", "worker-src 'self' blob:", "'wasm-unsafe-eval'"]) {
        if (!header.includes(d)) throw new Error(`header lacks ${d}: ${header}`);
      }
      // The meta copy comes before any script, so it covers all of them.
      const head = await page.evaluate(() => {
        const meta = document.querySelector('meta[http-equiv="Content-Security-Policy"]');
        const first = document.head.querySelector("script");
        return { meta: meta?.content ?? null, beforeScripts: !!meta && (!first || !!(meta.compareDocumentPosition(first) & Node.DOCUMENT_POSITION_FOLLOWING)) };
      });
      if (!head.meta?.includes("connect-src 'self'") || !head.beforeScripts) throw new Error(`meta: ${JSON.stringify(head)}`);
      if (head.meta.includes("frame-ancestors")) throw new Error("meta carries frame-ancestors, which browsers ignore there");
      return "header and meta";
    } finally {
      await ctx.close();
    }
  });

  // LibreOffice's glue (embind) builds functions from strings, so its worker
  // scripts, and only those, get a policy that allows eval. A worker's policy
  // comes from its own response, so pages stay without it.
  await test("only LibreOffice's worker scripts may eval", async () => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    try {
      await open(page, "/en/word-to-pdf");
      const csp = await page.evaluate(async (vendor) => {
        const get = async (path) => (await fetch(path, { cache: "no-store" })).headers.get("content-security-policy") ?? "";
        return { page: await get(location.pathname), worker: await get(`${vendor}libreoffice/soffice.js`), browserWorker: await get(`${vendor}libreoffice/browser.worker.js`) };
      }, VENDOR);
      if (csp.page.includes("'unsafe-eval'")) throw new Error(`page allows eval: ${csp.page}`);
      for (const which of ["worker", "browserWorker"]) {
        const v = csp[which];
        if (!v.includes("'unsafe-eval'") || !v.includes("connect-src 'self' blob: data:") || v.includes(",")) throw new Error(`${which}: ${v}`);
      }
      return "pages: no eval; soffice.js and browser.worker.js: eval, same connect-src";
    } finally {
      await ctx.close();
    }
  });

  await test("a request to another site is blocked", async () => {
    const ctx = await browser.newContext();
    const hits = await fakeOtherSite(ctx);
    const page = await ctx.newPage();
    try {
      await open(page, "/en/compress-pdf");
      const result = await probe(page);
      const detail = expectBlocked(result, hits);
      // Three addresses, though the header and the meta tag each report them.
      const c = await chipUntil(page, (c) => c.blocked === 3, "3 blocked requests");
      if (c.sent !== 0 || c.offsite !== 0) throw new Error(`chip: ${JSON.stringify(c)}`);
      return `${detail}; chip counts ${c.blocked} blocked`;
    } finally {
      await ctx.close();
    }
  });

  // GitHub Pages and other hosts that ignore _headers: the meta copy alone.
  await test("the meta tag alone blocks it on a host without headers", async () => {
    const ctx = await browser.newContext({ serviceWorkers: "block" });
    const hits = await fakeOtherSite(ctx);
    let stripped = false;
    await ctx.route(base + "/en/compress-pdf", async (route) => {
      const res = await route.fetch();
      const headers = { ...res.headers() };
      stripped = "content-security-policy" in headers;
      delete headers["content-security-policy"];
      await route.fulfill({ response: res, headers });
    });
    const page = await ctx.newPage();
    try {
      await open(page, "/en/compress-pdf");
      if (!stripped) throw new Error("the server sent no header to strip");
      return expectBlocked(await probe(page), hits);
    } finally {
      await ctx.close();
    }
  });

  await test("compress runs under the policy and the chip shows 0 bytes sent", async () => {
    const ctx = await browser.newContext({ acceptDownloads: true });
    const page = await ctx.newPage();
    await page.addInitScript(() => {
      window.__violations = [];
      document.addEventListener("securitypolicyviolation", (e) => window.__violations.push(`${e.effectiveDirective} ${e.blockedURI}`));
    });
    const errors = [];
    page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
    try {
      await open(page, "/en/compress-pdf");
      await pick(page, ["scanned.pdf"]);
      await Promise.all([page.waitForEvent("download", { timeout: 60000 }), page.getByRole("button", { name: "Compress PDF", exact: true }).click()]);
      const c = await chip(page);
      const violations = await page.evaluate(() => window.__violations);
      const csp = errors.filter((e) => /Content.Security.Policy|Refused to/i.test(e));
      if (violations.length || csp.length) throw new Error(`violations: ${[...violations, ...csp].join(" | ").slice(0, 300)}`);
      if (c.sent !== 0 || c.offsite !== 0 || c.blocked !== 0) throw new Error(`chip: ${JSON.stringify(c)}`);
      if (!/0 bytes/.test(c.text)) throw new Error(`chip text: ${c.text}`);
      return `chip: "${c.text.trim()}"`;
    } finally {
      await ctx.close();
    }
  });

  // A tool page loads the site's other pages in hidden frames to keep them
  // for offline use (src/lib/offline.ts): frame-ancestors must allow that.
  await test("a tool page's offline warm-up frames load under the policy", async () => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const errors = [];
    page.on("console", (m) => /Content.Security.Policy|frame-ancestors|Refused to/i.test(m.text()) && errors.push(m.text()));
    const framed = [];
    page.on("framenavigated", (f) => f !== page.mainFrame() && framed.push(f.url()));
    try {
      await open(page, "/en/compress-pdf");
      await page.waitForTimeout(6000);
      const broken = framed.filter((u) => !u.startsWith(base));
      if (errors.length || broken.length) throw new Error([...errors, ...broken].join(" | ").slice(0, 300));
      return `${framed.length} frames, no violations`;
    } finally {
      await ctx.close();
    }
  });

  // The chip isn't a constant: bytes that do leave (here, to this site)
  // show up, measured by the service worker.
  await test("the chip counts bytes that are sent", async () => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    try {
      await open(page, "/en/compress-pdf");
      await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 20000 });
      await page.evaluate(() => fetch("/nopload-chip-probe", { method: "POST", body: new Uint8Array(1234) }).catch(() => {}));
      const c = await chipUntil(page, (c) => c.sent === 1234, "1234 bytes sent");
      return `chip: "${c.text.trim()}"`;
    } finally {
      await ctx.close();
    }
  });
});
