// The host's own headers (out/_headers on Cloudflare Pages) make the very
// first visit cross-origin isolated, before any service worker exists, so
// high-fidelity Office conversion works without a reload.
export default async function isolation({ browser, base, test }) {
  await test("first visit is cross-origin isolated", async () => {
    const c = await browser.newContext({ serviceWorkers: "block" });
    const p = await c.newPage();
    const res = await p.goto(base + "/en/word-to-pdf");
    const headers = await res.allHeaders();
    const isolated = await p.evaluate(() => self.crossOriginIsolated);
    await c.close();
    if (!isolated) throw new Error(`not isolated (COOP ${headers["cross-origin-opener-policy"] ?? "missing"}, COEP ${headers["cross-origin-embedder-policy"] ?? "missing"})`);
    return "COOP + COEP from the host";
  });
}
