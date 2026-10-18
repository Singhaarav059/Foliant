// Shared setup for the browser add-on specs (extension.mjs in Chromium,
// extension-firefox.mjs in Firefox): the add-on built for a local site, the
// static build served on 3710, and another site with PDFs on 3711.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dict, fixture, root } from "./kit.mjs";

export const SITE = "http://127.0.0.1:3710";
export const FILES = "http://127.0.0.1:3711";
export const t = dict("en");
export const checksum = (b) => b.reduce((sum, x) => (sum * 33 + x) >>> 0, 0);

const cleanup = [];
export const onCleanup = (f) => cleanup.push(f);

// Exits (as a skip locally, a failure in CI) when the browser is missing.
export function requireBrowser(path, hint) {
  if (path && existsSync(path)) return path;
  console.log(`${process.env.CI ? "FAIL" : "skip"}  ${hint}`);
  process.exit(process.env.CI ? 1 : 0);
}

export async function setup() {
  if (!existsSync(join(root, "out/en.html")) && !existsSync(join(root, "out/en/index.html"))) {
    console.log("FAIL  no static build in out/ (run npm run build:static)");
    process.exit(1);
  }
  const temp = mkdtempSync(join(tmpdir(), "nopload-ext-e2e-"));
  onCleanup(() => rmSync(temp, { recursive: true, force: true }));

  // The add-on for this site, allowed to read 127.0.0.1 without asking (a test
  // can't answer the permission prompt). Files on "localhost" still need asking.
  const ext = join(temp, "build");
  const built = spawnSync(process.execPath, [join(root, "scripts/build-extension.mjs"), "--out", ext, "--test-host", "http://127.0.0.1/*"], {
    env: { ...process.env, NOPLOAD_RELEASE: "", NOPLOAD_EXTENSION_SITE_URL: SITE },
    encoding: "utf8",
  });
  if (built.status !== 0) {
    console.log(`FAIL  build: ${built.stdout}${built.stderr}`);
    process.exit(1);
  }

  // The static build, unless already served.
  const answers = () => fetch(`${SITE}/en`).then((r) => r.ok, () => false);
  if (!(await answers())) {
    const server = spawn(process.execPath, [join(root, "scripts/serve-static.mjs"), join(root, "out"), "3710"], { stdio: "ignore" });
    onCleanup(() => server.kill());
    for (let i = 0; i < 50 && !(await answers()); i++) await new Promise((r) => setTimeout(r, 200));
  }

  // Another site with PDFs, and a log of what was asked of it.
  const hits = [];
  const pdf = readFileSync(fixture("report.pdf"));
  // Several of the add-on's 1 MiB message pieces, with bytes that differ.
  const big = Buffer.concat([pdf, Buffer.from(Array.from({ length: 3.5 * 1024 * 1024 }, (_, i) => (i * 31 + 7) & 255))]);
  const files = createServer((req, res) => {
    if (req.url !== "/favicon.ico") hits.push(req.url);
    if (req.url === "/files/report.pdf") return res.writeHead(200, { "content-type": "application/pdf" }).end(pdf);
    if (req.url === "/files/big.pdf") return res.writeHead(200, { "content-type": "application/pdf" }).end(big);
    if (req.url.startsWith("/download"))
      return res.writeHead(200, { "content-type": "application/octet-stream", "content-disposition": `attachment; filename="x.bin"; filename*=UTF-8''Annual%20report%202026` }).end(pdf);
    if (req.url === "/files/fake.pdf") return res.writeHead(200, { "content-type": "application/pdf" }).end("<html>Sign in</html>");
    if (req.url === "/files/gone.pdf") return res.writeHead(404).end();
    if (req.url === "/") return res.writeHead(200, { "content-type": "text/html" }).end('<a href="/files/report.pdf">Report</a>');
    res.writeHead(404).end();
  });
  await new Promise((r) => files.listen(3711, "127.0.0.1", r));
  onCleanup(() => files.close());
  return { temp, ext, hits, big };
}

// PASS/FAIL lines like the other specs; `report` prints them, cleans up and exits.
const results = [];
export async function test(label, fn) {
  const t0 = Date.now();
  try {
    results.push({ label, ok: true, detail: (await fn()) ?? "" });
  } catch (e) {
    results.push({ label, ok: false, detail: e.message.split("\n")[0].slice(0, 200) });
  }
  results.at(-1).ms = Date.now() - t0;
}
export const fail = (label, e) => results.push({ label, ok: false, ms: 0, detail: e.message.split("\n")[0] });
export const ok = (cond, what) => {
  if (!cond) throw new Error(what);
};

export function report(browser) {
  for (const f of cleanup.reverse()) f();
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${browser.padEnd(9)} ${r.label.padEnd(58)} ${`${r.ms}ms`.padStart(8)}  ${r.detail}`);
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
}
