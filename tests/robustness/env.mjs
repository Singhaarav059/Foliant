// The engines in Node, for the hostile-input suite. Like tests/lib/load.mjs
// it compiles src/lib with tsc and loads it through a resolve hook, and it
// adds the browser pieces the engines touch: canvas (@napi-rs/canvas, which
// pdf.js uses in Node), toBlob, createImageBitmap, FileReader, location, and
// fetch of /vendor paths, which are read from public/vendor on disk.
//
// run.mjs passes one build folder to every case in NOPLOAD_ROBUST_BUILD, so
// only the first process (the fixture generator) runs tsc.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { register, createRequire } from "node:module";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
export const require = createRequire(join(ROOT, "package.json"));

// pdf.js loads its worker, cmaps, fonts and wasm from VENDOR; point it at the disk.
const vendorSrc = readFileSync(join(ROOT, "src/lib/vendor.ts"), "utf8");
export const vendorDir = join(ROOT, "public", vendorSrc.match(/VENDOR = "([^"]+)"/)[1]) + "/";

const OUT = process.env.NOPLOAD_ROBUST_BUILD ?? mkdtempSync(join(tmpdir(), "robust-build-"));
// A build of its own (gen.mjs or oracles.mjs run by hand) goes with the process.
if (!process.env.NOPLOAD_ROBUST_BUILD) process.on("exit", () => rmSync(OUT, { recursive: true, force: true }));
if (!existsSync(join(OUT, "hooks.mjs"))) {
  execFileSync(join(ROOT, "node_modules/.bin/tsc"), [
    "--outDir", OUT, "--module", "esnext", "--target", "es2022", "--moduleResolution", "bundler",
    "--skipLibCheck", "--noCheck", "--rootDir", "src/lib",
    "src/lib/pdf/convert.ts", "src/lib/pdf/optimize.ts", "src/lib/pdf/ocr.ts", "src/lib/pdf/security.ts",
    "src/lib/pdf/organize.ts", "src/lib/pdf/edit.ts", "src/lib/pdf/pdfa.ts", "src/lib/pdf/pdfium.ts",
  ], { cwd: ROOT, stdio: "inherit" });
  writeFileSync(join(OUT, "vendor.js"), `export const VENDOR_VERSION = ${JSON.stringify(vendorSrc.match(/VENDOR_VERSION = "([^"]+)"/)[1])};\nexport const VENDOR = ${JSON.stringify(vendorDir)};\n`);
  // Written last: its presence means the build is complete.
  writeFileSync(join(OUT, "hooks.mjs"), String.raw`
export async function resolve(spec, ctx, next) {
  const fromRoot = { ...ctx, parentURL: ${JSON.stringify(pathToFileURL(join(ROOT, "package.json")).href)} };
  if (spec === "pdfjs-dist") return next("pdfjs-dist/legacy/build/pdf.mjs", fromRoot);
  if (/^\.\.?\//.test(spec)) return next(/\.m?js$/.test(spec) ? spec : spec + ".js", ctx);
  if (spec.startsWith("/")) return next("file://" + spec.split("/").map(encodeURIComponent).join("/"), ctx);
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
}
register(pathToFileURL(join(OUT, "hooks.mjs")));

// ── Browser pieces
const napi = require("@napi-rs/canvas");
globalThis.ImageData ??= napi.ImageData;
globalThis.document ??= {
  createElement(tag) {
    if (tag !== "canvas") throw new Error(`robustness env: createElement(${tag}) is not supported`);
    const c = napi.createCanvas(1, 1);
    c.toBlob ??= (cb, type = "image/png", q = 0.92) => {
      try {
        if (c.width * c.height === 0) return cb(null);
        cb(new Blob([type === "image/png" ? c.toBuffer("image/png") : c.toBuffer(type, Math.round(q * 100))], { type }));
      } catch {
        cb(null);
      }
    };
    return c;
  },
};
globalThis.createImageBitmap ??= async (blob) => {
  const img = await napi.loadImage(Buffer.from(await blob.arrayBuffer()));
  img.close = () => {};
  return img;
};
globalThis.FileReader ??= class FileReader {
  readAsDataURL(blob) {
    blob.arrayBuffer().then((b) => {
      this.result = `data:${blob.type || "application/octet-stream"};base64,${Buffer.from(b).toString("base64")}`;
      this.onload?.();
    }, (e) => { this.error = e; this.onerror?.(); });
  }
};
globalThis.location ??= { origin: "http://localhost:3202", href: "http://localhost:3202/" };
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const s = String(url);
  if (!s.startsWith("/")) return realFetch(url, init);
  try {
    const type = s.endsWith(".wasm") ? "application/wasm" : s.endsWith(".json") ? "application/json" : "application/octet-stream";
    return new Response(readFileSync(s), { status: 200, headers: { "content-type": type } });
  } catch {
    return new Response("not found", { status: 404 });
  }
};

export const load = (name) => import(pathToFileURL(join(OUT, "pdf", `${name}.js`)).href);

(await load("jpeg")).wasm.load = async (name) => WebAssembly.compile(readFileSync(join(vendorDir, name)));
(await load("qpdf")).qpdfWasm.url = () => join(vendorDir, "qpdf.wasm");
(await load("pdfa")).pdfaFonts.load = async (file) => new Uint8Array(readFileSync(join(vendorDir, "pdfa-fonts", file)));
(await load("pdfium")).pdfiumWasm.load = async () => readFileSync(join(vendorDir, "pdfium.wasm")).buffer;

// The reference reader: pdf.js on its own, independent of the engines.
export async function refOpen(bytes, password) {
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  return getDocument({
    data: bytes.slice(), password, verbosity: 0,
    cMapUrl: vendorDir + "pdfjs/cmaps/", standardFontDataUrl: vendorDir + "pdfjs/standard_fonts/",
    wasmUrl: vendorDir + "pdfjs/wasm/", iccUrl: vendorDir + "pdfjs/iccs/",
  }).promise;
}

// Page count, and for up to 40 pages (or a sample of longer files) each
// page's text, rotation, view box and annotations.
export async function refInfo(bytes, password) {
  const doc = await refOpen(bytes, password);
  const n = doc.numPages;
  const sample = n > 40 ? [1, 2, Math.floor(n / 2), n - 1, n] : Array.from({ length: n }, (_, i) => i + 1);
  const pages = [];
  for (const i of sample) {
    const p = await doc.getPage(i);
    const text = (await p.getTextContent()).items.map((x) => x.str).join(" ").replace(/\s+/g, " ").trim();
    const annots = (await p.getAnnotations()).map((a) => a.subtype);
    pages.push({ i, rotate: p.rotate, view: p.view.map((v) => Math.round(v)), text, annots });
    p.cleanup();
  }
  const count = (m) => (!m ? 0 : m instanceof Map ? m.size : Object.keys(m).length);
  const meta = {
    numPages: n, pages,
    attachments: count(await doc.getAttachments().catch(() => null)),
    outline: (await doc.getOutline().catch(() => null))?.length ?? 0,
    fields: count(await doc.getFieldObjects().catch(() => null)),
  };
  await doc.loadingTask.destroy();
  return meta;
}

export const fileOf = (bytes, name) => new File([bytes], name, { type: "application/pdf" });
