// Compiles src/lib/pdf to plain JavaScript and loads it in Node, so the
// converters can be tested without a browser. pdf.js runs its legacy build.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire, register } from "node:module";

export const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const out = mkdtempSync(join(tmpdir(), "pdf-lib-"));

execFileSync(join(root, "node_modules/.bin/tsc"), [
  "--outDir", out, "--module", "esnext", "--target", "es2022", "--moduleResolution", "bundler",
  "--skipLibCheck", "--noCheck", "--rootDir", "src/lib", "src/lib/pdf/convert.ts", "src/lib/pdf/optimize.ts", "src/lib/pdf/ocr.ts", "src/lib/pdf/security.ts", "src/lib/pdf/compare.ts", "src/lib/pdf/run.ts",
], { cwd: root, stdio: "inherit" });

// Node needs file extensions on relative imports, and bare imports resolved from the project.
writeFileSync(join(out, "hooks.mjs"), String.raw`
export async function resolve(spec, ctx, next) {
  const fromRoot = { ...ctx, parentURL: ${JSON.stringify(pathToFileURL(join(root, "package.json")).href)} };
  if (spec === "pdfjs-dist") return next("pdfjs-dist/legacy/build/pdf.mjs", fromRoot);
  if (/^\.\.?\//.test(spec)) return next(/\.m?js$/.test(spec) ? spec : spec + ".js", ctx);
  if (!spec.startsWith("node:") && !spec.startsWith("file:")) {
    // Deep imports without an extension ("pkg/runtime") work in bundlers, not in Node.
    try {
      return await next(spec, fromRoot);
    } catch (e) {
      if (/^[^.][^:]*\/[^/.]+$/.test(spec)) return next(spec + ".js", fromRoot);
      throw e;
    }
  }
  return next(spec, ctx);
}`);
register(pathToFileURL(join(out, "hooks.mjs")));

export const load = (name) => import(pathToFileURL(join(out, "pdf", `${name}.js`)).href);

// WASM the browser fetches from /vendor is read from disk instead.
const { VENDOR } = await import(pathToFileURL(join(out, "vendor.js")).href);
const vendorDir = join(root, "public", VENDOR);
(await load("jpeg")).wasm.load = async (name) => WebAssembly.compile(readFileSync(join(vendorDir, name)));
(await load("qpdf")).qpdfWasm.url = () => join(vendorDir, "qpdf.wasm");
(await load("pdfa")).pdfaFonts.load = async (file) => new Uint8Array(readFileSync(join(vendorDir, "pdfa-fonts", file)));
(await load("pdfium")).pdfiumWasm.load = async () => readFileSync(join(vendorDir, "pdfium.wasm")).buffer;
// jSquash's decoder returns ImageData, which Node lacks.
globalThis.ImageData ??= class ImageData {
  constructor(data, width, height) {
    Object.assign(this, { data, width, height, colorSpace: "srgb" });
  }
};

export { vendorDir };

export async function openPdf(bytes) {
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  return getDocument({ data: bytes, fontExtraProperties: true, standardFontDataUrl: join(root, "node_modules/pdfjs-dist/standard_fonts/"), verbosity: 0 }).promise;
}

// Pages drawn as images need a canvas: a Node one stands in for the browser's.
// @napi-rs/canvas (MIT) comes with pdfjs-dist, which uses it in Node.
export function nodeCanvas() {
  const { createCanvas } = createRequire(join(root, "package.json"))("@napi-rs/canvas");
  globalThis.document = {
    createElement: () => {
      const c = createCanvas(1, 1);
      c.toBlob = (cb, type, q) => cb(new Blob([c.toBuffer(type === "image/png" ? "image/png" : "image/jpeg", Math.round((q ?? 0.9) * 100))]));
      return c;
    },
  };
}

export function check(results) {
  return async (name, fn) => {
    try {
      await fn();
      console.log(`ok    ${name}`);
    } catch (e) {
      results.failed++;
      console.log(`FAIL  ${name}: ${e.message}`);
    }
  };
}

export function eq(a, b, what) {
  if (a !== b) throw new Error(`${what}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}
