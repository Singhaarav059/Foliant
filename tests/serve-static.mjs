// The local stand-in for Cloudflare Pages (scripts/serve-static.mjs) that the
// end-to-end tests and CI's host checks run against: pages, 404s, the
// _headers rules and static _redirects, and a malformed request gets a 400 without taking the
// server down for every later test.
//
//   node tests/serve-static.mjs
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
let failed = 0;
const test = async (name, fn) => {
  try {
    await fn();
    console.log(`ok    ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL  ${name}: ${e.message || e.code}`);
  }
};
const eq = (a, b, what) => {
  if (a !== b) throw new Error(`${what}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
};

// A stand-in build: a page, a language folder with its own 404, and _headers.
const out = mkdtempSync(join(tmpdir(), "serve-static-"));
writeFileSync(join(out, "index.html"), "home");
mkdirSync(join(out, "en"));
writeFileSync(join(out, "en.html"), "english");
writeFileSync(join(out, "en", "404.html"), "english 404");
writeFileSync(join(out, "404.html"), "404");
writeFileSync(join(out, "_headers"), "/*\n  Cross-Origin-Opener-Policy: same-origin\n/en/*\n  X-Lang: en\n");
writeFileSync(join(out, "en", "old.html"), "left behind");
writeFileSync(join(out, "_redirects"), "/en/old /en 301\n");

// Port 0: the system picks a free one, and the server says which.
const server = spawn(process.execPath, [join(root, "scripts/serve-static.mjs"), out, "0"], { stdio: ["ignore", "pipe", "pipe"] });
let log = "";
server.stderr.on("data", (d) => (log += d));
const port = await new Promise((resolve, reject) => {
  server.stdout.on("data", (d) => {
    const m = String(d).match(/localhost:(\d+)/);
    if (m) resolve(Number(m[1]));
  });
  server.on("exit", (code) => reject(new Error(`server exited with ${code}: ${log}`)));
});

// Raw paths, sent as they are (fetch would normalise them).
const get = (path) => new Promise((resolve, reject) => {
  const req = request({ host: "localhost", port, path }, (res) => {
    let body = "";
    res.on("data", (d) => (body += d));
    res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
  });
  req.on("error", reject);
  req.end();
});

await test("serves /en from en.html with the /* headers", async () => {
  const r = await get("/en");
  eq(r.status, 200, "status");
  eq(r.body, "english", "body");
  eq(r.headers["cross-origin-opener-policy"], "same-origin", "COOP");
});

await test("a missing page gets the nearest 404.html and its path's headers", async () => {
  const r = await get("/en/no-such-page");
  eq(r.status, 404, "status");
  eq(r.body, "english 404", "body");
  eq(r.headers["x-lang"], "en", "X-Lang");
});

await test("_redirects wins over a file at the old address, as on Cloudflare Pages", async () => {
  const r = await get("/en/old");
  eq(r.status, 301, "status");
  eq(r.headers.location, "/en", "Location");
  eq(r.headers["cross-origin-opener-policy"], "same-origin", "COOP");
});

for (const path of ["//", "/%E0%A4%A"]) {
  await test(`answers ${path} with 400 and keeps serving`, async () => {
    eq((await get(path)).status, 400, "status");
    eq((await get("/en")).status, 200, "next request");
  });
}

server.kill();
rmSync(out, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
