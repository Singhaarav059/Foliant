// Office → PDF in the static build, around LibreOffice: Automatic prints when
// LibreOffice fails, hangs or dies (src/lib/pdf/run.ts and
// src/lib/office/libreoffice.ts, with a stand-in for the converter), and a
// job saved for the reload doesn't outlive it (src/lib/resume.ts, in Chrome
// for IndexedDB; skipped without Chrome).
//
//   node tests/office-run.mjs
import pw from "playwright-core";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { root, check, eq } from "./lib/load.mjs";

process.env.NEXT_PUBLIC_STATIC = "1";
const out = mkdtempSync(join(tmpdir(), "office-run-"));
execFileSync(join(root, "node_modules/.bin/tsc"), [
  "--outDir", out, "--module", "esnext", "--target", "es2022", "--moduleResolution", "bundler", "--skipLibCheck", "--noCheck",
  "--rootDir", "src/lib", "src/lib/pdf/run.ts", "src/lib/office/libreoffice.ts", "src/lib/resume.ts", "src/lib/mode.ts",
], { cwd: root, stdio: "inherit" });

// The converter and the print route are stand-ins; the rest is the real code.
writeFileSync(join(out, "converter.js"), `export class WorkerBrowserConverter {
  constructor(options) { this.options = options; this.worker = { terminate: () => (this.terminated = true) }; lo.made.push(this); }
  initialize() { return lo.initialize(this); }
  convert(input, opts, name) { return lo.convert(this, name); }
  // A dead worker never answers the goodbye either.
  destroy() { return new Promise(() => {}); }
}`);
writeFileSync(join(out, "print.js"), `export const printable = async (f) => ({ name: f.name + ".print.html", blob: new Blob([]) });`);
writeFileSync(join(out, "office-hooks.mjs"), String.raw`
const out = ${JSON.stringify(pathToFileURL(out + "/").href)};
export async function resolve(spec, ctx, next) {
  if (spec === "@matbee/libreoffice-converter/browser") return next(out + "converter.js", ctx);
  if (spec === "@/lib/office/print") return next(out + "print.js", ctx);
  if (spec.startsWith("@/lib/")) return next(out + spec.slice(6) + ".js", ctx);
  return next(spec, ctx);
}`);
register(pathToFileURL(join(out, "office-hooks.mjs")));

// What the browser gives LibreOffice: an isolated page, and its download.
globalThis.crossOriginIsolated = true;
globalThis.location = { origin: "http://test.local" };
const part = gzipSync(Buffer.from("x"));
globalThis.fetch = async (url) =>
  String(url).endsWith("manifest.json")
    ? Response.json({ version: "1", files: { "soffice.wasm": { parts: ["w.gz"], size: part.length }, "soffice.data": { parts: ["d.gz"], size: part.length } } })
    : new Response(part);

const { runTool } = await import(pathToFileURL(join(out, "pdf/run.js")).href);
const { officeLimits } = await import(pathToFileURL(join(out, "office/libreoffice.js")).href);
const never = () => new Promise(() => {});
const pdf = async () => ({ data: new Uint8Array([37, 80, 68, 70]) });
const lo = (globalThis.lo = { made: [], initialize: async () => {}, convert: pdf });
const reset = (o) => Object.assign(lo, { made: [], initialize: async () => {}, convert: pdf }, o);
if (officeLimits) Object.assign(officeLimits, { startMs: 200, convertMs: 200 });

const results = { failed: 0 };
const test = check(results);
const docx = () => new File(["word"], "brief.docx");
// A job that never settles is the bug: give up on it well before the suite would.
const job = (fidelity) =>
  Promise.race([runTool("wordToPdf", [docx()], { fidelity }), new Promise((_, no) => setTimeout(() => no(new Error("never settled")), 5000))]);
const names = (res) => res.map((r) => r.name).join(", ");
// LibreOffice, once started, serves every later job: the failures come first.

await test("standard prints without starting LibreOffice", async () => {
  reset();
  eq(names(await job("standard")), "brief.docx.print.html", "output");
  eq(lo.made.length, 0, "converters started");
});

await test("automatic prints when LibreOffice fails to start", async () => {
  reset({ initialize: async () => { throw new Error("Aborted()"); } });
  eq(names(await job("auto")), "brief.docx.print.html", "output");
});

await test("high reports the failure instead of printing", async () => {
  reset({ initialize: async () => { throw new Error("Aborted()"); } });
  // The typed error (src/lib/pdf/errors.ts) keeps LibreOffice's own failure as its cause.
  const err = await job("high").then(() => null, (e) => `${e.message} / ${e.cause?.message ?? ""}`);
  eq(/Aborted/.test(err ?? ""), true, `error (got ${err})`);
});

// WebKit: the worker aborts, and the promise LibreOffice was asked for never settles.
await test("automatic prints when LibreOffice never finishes starting", async () => {
  reset({ initialize: never });
  eq(names(await job("auto")), "brief.docx.print.html", "output");
  eq(lo.made[0]?.terminated, true, "stuck worker stopped");
});

await test("high says LibreOffice stopped responding", async () => {
  reset({ initialize: never });
  const code = await job("high").then(() => null, (e) => e.code ?? e.message);
  eq(code, "office_stalled", "error");
});

await test("automatic prints as soon as LibreOffice's worker dies", async () => {
  if (officeLimits) officeLimits.startMs = 60_000;
  reset({ initialize: (c) => (setTimeout(() => c.options.onError?.(new Error("RuntimeError: Aborted")), 20), never()) });
  eq(names(await job("auto")), "brief.docx.print.html", "output");
  if (officeLimits) officeLimits.startMs = 200;
});

await test("automatic writes the PDF with LibreOffice", async () => {
  reset();
  eq(names(await job("auto")), "brief.pdf", "output");
});

await test("a conversion that never ends prints, and the next job starts LibreOffice afresh", async () => {
  let stuck = null;
  reset({ convert: (c) => ((stuck = c), never()) });
  eq(names(await job("auto")), "brief.docx.print.html", "output");
  eq(stuck?.terminated, true, "stuck worker stopped");
  lo.convert = pdf;
  eq(names(await job("auto")), "brief.pdf", "next output");
  eq(lo.made.length === 1 && lo.made[0] !== stuck, true, "a new LibreOffice started");
});

// ── The job kept over the reload

const chrome = process.env.CHROME_PATH ?? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium"].find(existsSync);
if (!chrome) console.log("skip  resume: no Chrome found (set CHROME_PATH)");
else {
  const browser = await pw.chromium.launch({ executablePath: chrome });
  const page = await browser.newPage();
  const files = {
    "/": `<!doctype html><script type="module">import * as r from "/resume.js"; window.resume = r;</script>`,
    "/resume.js": readFileSync(join(out, "resume.js")),
  };
  await page.route("http://test.local/**", (route) => {
    const body = files[new URL(route.request().url()).pathname];
    return body === undefined ? route.fulfill({ status: 404 }) : route.fulfill({ body, contentType: route.request().url().endsWith(".js") ? "text/javascript" : "text/html" });
  });
  await page.goto("http://test.local/");
  await page.waitForFunction(() => window.resume);
  // Saves a job for `tool` as saveJob does, `age` ms old, and lists what's stored after peeking at `peek`.
  const after = (jobs, peek) => page.evaluate(async ({ jobs, peek }) => {
    const db = await new Promise((ok) => { const r = indexedDB.open("foliant", 1); r.onupgradeneeded = () => r.result.createObjectStore("resume"); r.onsuccess = () => ok(r.result); });
    const run = (mode, fn) => new Promise((ok) => { const t = db.transaction("resume", mode); const q = fn(t.objectStore("resume")); t.oncomplete = () => ok(q.result); });
    await run("readwrite", (s) => s.clear());
    for (const [tool, age] of jobs) await run("readwrite", (s) => s.put({ tool, files: [new File(["salary letter"], "salary.docx")], options: {}, at: Date.now() - age }, tool));
    db.close();
    const got = await window.resume.peekJob(peek);
    const db2 = await new Promise((ok) => { const r = indexedDB.open("foliant", 1); r.onsuccess = () => ok(r.result); });
    const keys = await new Promise((ok) => { const q = db2.transaction("resume").objectStore("resume").getAllKeys(); q.onsuccess = () => ok(q.result); });
    db2.close();
    return { got: got?.tool ?? null, kept: keys.join(",") };
  }, { jobs, peek });

  await test("a fresh job is handed back and kept until the workspace clears it", async () => {
    const r = await after([["wordToPdf", 1000]], "wordToPdf");
    eq(r.got, "wordToPdf", "handed back");
    eq(r.kept, "wordToPdf", "stored");
  });

  await test("a job the reload never picked up is deleted when found", async () => {
    const r = await after([["wordToPdf", 6 * 60_000]], "wordToPdf");
    eq(r.got, null, "handed back");
    eq(r.kept, "", "stored");
  });

  await test("stale jobs of other tools go too", async () => {
    const r = await after([["pptToPdf", 6 * 60_000], ["excelToPdf", 1000]], "wordToPdf");
    eq(r.kept, "excelToPdf", "stored");
  });
  await browser.close();
}

process.exit(results.failed ? 1 : 0);
