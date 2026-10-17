// Checks a deployed copy of the static build over HTTP: the headers the host
// must send (cross-origin isolation, no-cache for the service worker,
// immutable caching for hashed assets), real 404s, and that pages listed in
// the sitemap load. The scheduled live workflow runs it, and CI runs it
// against the local server.
// Usage: node scripts/live-check.mjs <site-url>
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const site = process.argv[2]?.replace(/\/+$/, "");
if (!site) {
  console.error("usage: node scripts/live-check.mjs <site-url>");
  process.exit(2);
}
const vendorTs = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../src/lib/vendor.ts"), "utf8");
const VENDOR = vendorTs.match(/VENDOR = "([^"]+)"/)[1];
let failed = 0;

const get = (path) => fetch(new URL(path, site + "/"), { redirect: "follow", signal: AbortSignal.timeout(30000) });
async function check(label, fn) {
  try {
    console.log(`PASS  ${label.padEnd(36)} ${await fn()}`);
  } catch (e) {
    failed++;
    console.log(`FAIL  ${label.padEnd(36)} ${e.cause?.code ?? e.message}`);
  }
}
const expect = (ok, message) => {
  if (!ok) throw new Error(message);
};
const header = (res, name) => res.headers.get(name) ?? "missing";

let home = "";
await check("/en is cross-origin isolated", async () => {
  const res = await get("/en");
  expect(res.status === 200, `status ${res.status}`);
  home = await res.text();
  const coop = header(res, "cross-origin-opener-policy"), coep = header(res, "cross-origin-embedder-policy");
  expect(coop === "same-origin" && coep === "require-corp", `COOP ${coop}, COEP ${coep}`);
  expect(header(res, "x-content-type-options") === "nosniff", `X-Content-Type-Options ${header(res, "x-content-type-options")}`);
  return "COOP same-origin, COEP require-corp";
});
await check("/sw.js is revalidated", async () => {
  const res = await get("/sw.js");
  expect(res.status === 200, `status ${res.status}`);
  expect(/no-cache/.test(header(res, "cache-control")), `Cache-Control ${header(res, "cache-control")}`);
  return header(res, "cache-control");
});
await check("vendor files are immutable", async () => {
  const res = await get(`${VENDOR}pdf.worker.min.mjs`);
  expect(res.status === 200, `${VENDOR}pdf.worker.min.mjs: status ${res.status} (is the deployment older than this commit?)`);
  expect(/immutable/.test(header(res, "cache-control")), `Cache-Control ${header(res, "cache-control")}`);
  await res.body?.cancel();
  return header(res, "cache-control");
});
await check("/_next/static files are immutable", async () => {
  const asset = home.match(/\/_next\/static\/[^"'\s)]+/)?.[0];
  expect(asset, "no /_next/static asset referenced by /en");
  const res = await get(asset);
  expect(res.status === 200, `${asset}: status ${res.status}`);
  expect(/immutable/.test(header(res, "cache-control")), `Cache-Control ${header(res, "cache-control")}`);
  await res.body?.cancel();
  return header(res, "cache-control");
});
await check("a missing page is a 404", async () => {
  const res = await get("/en/no-such-page-for-live-check");
  await res.body?.cancel();
  expect(res.status === 404, `status ${res.status}`);
  return "404";
});
// Pages from the sitemap, mapped onto the site being checked (it may be a
// preview address). Without a sitemap, the links on /en stand in.
await check("20 random pages load", async () => {
  const res = await get("/sitemap.xml");
  let paths;
  let from = "sitemap.xml";
  if (res.status === 200) {
    paths = [...(await res.text()).matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => new URL(m[1]).pathname);
  } else {
    await res.body?.cancel();
    from = `links on /en (no sitemap.xml: ${res.status})`;
    paths = [...new Set([...home.matchAll(/href="(\/en\/[^"#?]+)"/g)].map((m) => m[1]))];
  }
  expect(paths.length, `no pages found in ${from}`);
  const sample = paths.sort(() => Math.random() - 0.5).slice(0, 20);
  const bad = [];
  for (const path of sample) {
    const page = await get(path);
    await page.body?.cancel();
    if (page.status !== 200) bad.push(`${path} ${page.status}`);
  }
  expect(!bad.length, bad.join(", "));
  return `${sample.length} of ${paths.length} from ${from}`;
});

console.log(`\n${failed ? `${failed} check(s) failed` : "all checks passed"} for ${site}`);
process.exit(failed ? 1 : 0);
