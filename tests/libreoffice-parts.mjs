// The browser's LibreOffice loader (src/lib/office/libreoffice.ts), run in
// Node with the network and the converter stubbed: it downloads each file's
// parts in order, joins and unzips them, and hands LibreOffice the result. A
// page that isn't cross-origin isolated is refused before anything downloads.
//
//   node tests/libreoffice-parts.mjs
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { randomBytes } from "node:crypto";

const root = join(fileURLToPath(import.meta.url), "../..");
let failed = 0;
const test = async (name, fn) => {
  try {
    await fn();
    console.log(`ok    ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL  ${name}: ${e.message}`);
  }
};
const eq = (a, b, what) => {
  if (a !== b) throw new Error(`${what}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
};
const out = mkdtempSync(join(tmpdir(), "lo-parts-"));
execFileSync(join(root, "node_modules/.bin/tsc"), [
  "--outDir", out, "--module", "esnext", "--target", "es2022", "--moduleResolution", "bundler",
  "--skipLibCheck", "--noCheck", "--rootDir", "src/lib/office", "src/lib/office/libreoffice.ts",
], { cwd: root, stdio: "inherit" });

// Stand-ins for the module's imports: the vendor path, baseName, the export
// options (a plain PDF export here), and the converter, which records what it was given (read before the loader revokes the URLs).
writeFileSync(join(out, "vendor.mjs"), `export const VENDOR = "/vendor/test/";`);
writeFileSync(join(out, "common.mjs"), `export const baseName = (n) => n.replace(/\\.[^.]+$/, "");
export const abortable = (work) => work;`);
writeFileSync(join(out, "export.mjs"), `export const exportPdf = (convert, data, name) => convert(data, "pdf", name);`);
writeFileSync(join(out, "converter.mjs"), `
import { resolveObjectURL } from "node:buffer";
export class WorkerBrowserConverter {
  constructor(o) { this.o = o; globalThis.__lo = { options: o }; }
  async initialize() {
    globalThis.__lo.wasm = Buffer.from(await resolveObjectURL(this.o.sofficeWasm).arrayBuffer());
    globalThis.__lo.data = Buffer.from(await resolveObjectURL(this.o.sofficeData).arrayBuffer());
  }
  async convert(input) { return { data: new TextEncoder().encode("%PDF-1.7 converted " + input.length) }; }
}`);
writeFileSync(join(out, "hooks.mjs"), `
const map = {
  "@/lib/vendor": ${JSON.stringify(pathToFileURL(join(out, "vendor.mjs")).href)},
  "@/lib/pdf/common": ${JSON.stringify(pathToFileURL(join(out, "common.mjs")).href)},
  "@matbee/libreoffice-converter/browser": ${JSON.stringify(pathToFileURL(join(out, "converter.mjs")).href)},
  "./export": ${JSON.stringify(pathToFileURL(join(out, "export.mjs")).href)},
};
export async function resolve(spec, ctx, next) {
  return map[spec] ? { url: map[spec], shortCircuit: true } : next(spec, ctx);
}`);
register(pathToFileURL(join(out, "hooks.mjs")));

// Two files, each gzipped and cut into parts, the way scripts/vendor.mjs ships them.
const wasm = randomBytes(300_000);
const data = Buffer.concat([randomBytes(200_000), Buffer.from("end of soffice.data")]);
const cut = (buf, n) => Array.from({ length: n }, (_, i) => buf.subarray(Math.floor((buf.length * i) / n), Math.floor((buf.length * (i + 1)) / n)));
const served = new Map();
const manifest = { version: "test", files: {} };
for (const [name, bytes, n] of [["soffice.wasm", wasm, 3], ["soffice.data", data, 4]]) {
  const gz = gzipSync(bytes);
  const parts = cut(gz, n).map((b, i) => {
    const part = `${name}.gz.${String(i).padStart(2, "0")}`;
    served.set(part, b);
    return part;
  });
  manifest.files[name] = { parts, size: gz.length };
}
const fetched = [];
globalThis.location = { origin: "http://test.local" };
globalThis.fetch = async (url) => {
  const name = String(url).replace("http://test.local/vendor/test/libreoffice/", "");
  fetched.push(name);
  if (name === "manifest.json") return new Response(JSON.stringify(manifest));
  return served.has(name) ? new Response(served.get(name)) : new Response("missing", { status: 404 });
};

const lo = await import(pathToFileURL(join(out, "libreoffice.js")).href);
const docx = new File([new Uint8Array(1234)], "brief.docx");

await test("not cross-origin isolated: refused before any download", async () => {
  globalThis.crossOriginIsolated = false;
  eq(lo.officeAvailable(), false, "available");
  const e = await lo.officeToPdf(docx).then(() => null, (err) => err);
  eq(e?.code, "office_isolation", "error code");
  eq(fetched.length, 0, "requests");
});

await test("isolated: the parts are fetched and joined in order", async () => {
  globalThis.crossOriginIsolated = true;
  eq(lo.officeAvailable(), true, "available");
  const progress = [];
  const pdf = await lo.officeToPdf(docx, (done, total) => progress.push([done, total]));
  eq(fetched.join(" "), ["manifest.json", ...manifest.files["soffice.wasm"].parts, ...manifest.files["soffice.data"].parts].join(" "), "request order");
  eq(Buffer.compare(globalThis.__lo.wasm, wasm), 0, "soffice.wasm as shipped");
  eq(Buffer.compare(globalThis.__lo.data, data), 0, "soffice.data as shipped");
  eq(pdf.name, "brief.pdf", "output name");
  eq((await pdf.blob.text()).startsWith("%PDF-"), true, "output is the converter's");
  const last = progress.at(-1);
  eq(last?.[0] === last?.[1] && last[1] > 0, true, "progress reaches the end");
});

process.exit(failed ? 1 : 0);
