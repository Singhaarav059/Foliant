// The host's own headers (out/_headers on Cloudflare Pages) make the very
// first visit cross-origin isolated, before any service worker exists, so
// high-fidelity Office conversion works without a reload. HOST_HEADERS=none
// skips this for a host that ignores _headers (GitHub Pages).
export default async function isolation({ browser, base, test }) {
  if (process.env.HOST_HEADERS === "none") return;
  await test("first visit is cross-origin isolated", async () => {
    const c = await browser.newContext({ serviceWorkers: "block" });
    try {
      const p = await c.newPage();
      const res = await p.goto(base + "/en/word-to-pdf");
      // A 404 page carries the same headers; make sure this is the Word tool.
      if (res.status() !== 200) throw new Error(`status ${res.status()}`);
      await p.locator('input[type=file][accept*=".docx"]').waitFor({ state: "attached", timeout: 20000 });
      const headers = await res.allHeaders();
      const isolated = await p.evaluate(() => self.crossOriginIsolated);
      if (!isolated) throw new Error(`not isolated (COOP ${headers["cross-origin-opener-policy"] ?? "missing"}, COEP ${headers["cross-origin-embedder-policy"] ?? "missing"})`);
      return "COOP + COEP from the host";
    } finally {
      await c.close();
    }
  });
}
