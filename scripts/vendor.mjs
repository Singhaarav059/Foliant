// Copies runtime assets the browser loads by URL into public/vendor, so their
// versions always match the installed packages and nothing is fetched from a
// CDN. Runs on postinstall.
//
// Files land in public/vendor/<hash>/, where the hash covers their contents,
// and src/lib/vendor.ts (generated, not committed) exports that path. New
// package versions therefore get new URLs, so neither the service worker nor
// a browser cache can pair new page code with an old worker or WASM file.
// Licence texts, which change with any library update, go to
// public/vendor/licenses/<hash>/ instead, so updating a library doesn't make
// browsers download every engine again.
import { createHash } from "node:crypto";
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { padWoff } from "./pad-woff.mjs";

const require = createRequire(import.meta.url);
const root = join(process.cwd(), "public", "vendor");
rmSync(root, { recursive: true, force: true });
const out = join(root, "staging");
mkdirSync(out, { recursive: true });

const pkgDir = (name) => dirname(require.resolve(`${name}/package.json`));

// Content hash of a folder's files, in a stable file order.
const hashOf = (dir) => {
  const hash = createHash("sha256");
  const walk = (d) => readdirSync(d, { withFileTypes: true })
    .sort((a, b) => (a.name < b.name ? -1 : 1))
    .forEach((e) => {
      const p = join(d, e.name);
      if (e.isDirectory()) return walk(p);
      hash.update(p.slice(dir.length)).update(readFileSync(p));
    });
  walk(dir);
  return hash.digest("hex").slice(0, 12);
};

const files = [
  [join(pkgDir("pdfjs-dist"), "build", "pdf.worker.min.mjs"), "pdf.worker.min.mjs"],
  [join(pkgDir("@neslinesli93/qpdf-wasm"), "dist", "qpdf.wasm"), "qpdf.wasm"],
  // MozJPEG for Compress (src/lib/pdf/jpeg.ts).
  [join(pkgDir("@jsquash/jpeg"), "codec", "enc", "mozjpeg_enc.wasm"), "mozjpeg_enc.wasm"],
  [join(pkgDir("@jsquash/jpeg"), "codec", "dec", "mozjpeg_dec.wasm"), "mozjpeg_dec.wasm"],
  // PDFium (EmbedPDF's build, with redaction) for Redact (src/lib/pdf/pdfium.ts).
  [require.resolve("@embedpdf/pdfium/pdfium.wasm"), "pdfium.wasm"],
  [join(pkgDir("tesseract.js"), "dist", "worker.min.js"), "tesseract/worker.min.js"],
];
// Metric-compatible stand-ins for fonts a PDF names but doesn't embed, which
// PDF/A requires embedded (src/lib/pdf/pdfa.ts): Arimo for Arial/Helvetica,
// Tinos for Times, Cousine for Courier, Carlito for Calibri, Caladea for Cambria.
// Office to PDF (src/lib/office/faces.ts) also lays text out in them, so
// every subset they come in is copied, not only Latin.
for (const family of ["arimo", "tinos", "cousine", "carlito", "caladea"])
  for (const subset of ["latin", "latin-ext", "vietnamese", "cyrillic", "cyrillic-ext", "greek", "greek-ext"])
    for (const weight of [400, 700])
      for (const style of ["normal", "italic"]) {
        const file = `${family}-${subset}-${weight}-${style}.woff`;
        const from = join(pkgDir(`@fontsource/${family}`), "files", file);
        if (subset === "latin" || existsSync(from)) files.push([from, `pdfa-fonts/${file}`]);
      }
// Handwriting fonts for typed signatures (src/components/workspace/SignaturePad.tsx),
// so they look the same on every system. Latin and Latin Extended slices.
for (const family of ["dancing-script", "great-vibes", "caveat"])
  for (const subset of ["latin", "latin-ext"]) {
    const file = `${family}-${subset}-400-normal.woff2`;
    files.push([join(pkgDir(`@fontsource/${family}`), "files", file), `signature-fonts/${file}`]);
  }
// High-accuracy OCR (src/lib/pdf/paddle.ts): ONNX Runtime Web's CPU build and
// PaddleOCR's PP-OCRv5 mobile models. Fetched only when that mode is used.
files.push(
  [require.resolve("onnxruntime-web/ort-wasm-simd-threaded.wasm"), "paddle/ort-wasm-simd-threaded.wasm"],
  [require.resolve("onnxruntime-web/ort-wasm-simd-threaded.mjs"), "paddle/ort-wasm-simd-threaded.mjs"],
  [join(pkgDir("pdfmarkdown-ppocrv5-models"), "detection", "PP-OCRv5_mobile_det_infer.ort"), "paddle/det.ort"],
  [join(pkgDir("pdfmarkdown-ppocrv5-models"), "recognition", "PP-OCRv5_mobile_rec_infer.onnx"), "paddle/rec.onnx"],
  [join(pkgDir("pdfmarkdown-ppocrv5-models"), "recognition", "ppocrv5_dict.txt"), "paddle/dict.txt"],
  [join(pkgDir("pdfmarkdown-ppocrv5-models"), "LICENSE"), "paddle/LICENSE"],
);
// HEIC/HEIF photos where the browser can't decode them (src/lib/pdf/images.ts).
// libheif and the libde265 HEVC decoder it compiles in are LGPL-3.0, so they
// stay separate files, loaded only for a HEIC and replaceable with any build
// of the same interface, never bundled into the page code. worker.js is ours.
files.push(
  [join(pkgDir("libheif-js"), "libheif-wasm", "libheif.js"), "heif/libheif.js"],
  [join(pkgDir("libheif-js"), "libheif-wasm", "libheif.wasm"), "heif/libheif.wasm"],
  [join(process.cwd(), "scripts", "heif-worker.js"), "heif/worker.js"],
);
// Tesseract picks one of these by the browser's SIMD support. OCR runs the
// LSTM engine only, so the legacy-engine builds aren't needed.
for (const f of ["tesseract-core-lstm.wasm.js", "tesseract-core-simd-lstm.wasm.js", "tesseract-core-relaxedsimd-lstm.wasm.js"]) {
  files.push([join(pkgDir("tesseract.js-core"), f), `tesseract/${f}`]);
}
// OCR languages: the gzipped "best_int" LSTM models, the same files the
// tesseract.js CDN serves by default, one file each (0.3-6 MB), fetched only
// for the languages a user picks. Every @tesseract.js-data/* dependency is
// picked up, so adding a language is one npm install plus OCR_LANGS. Some of
// those packages hold only a legacy-engine model, which the LSTM-only core
// can't run: they must not be installed.
const scope = join(dirname(pkgDir("@tesseract.js-data/eng")));
for (const lang of readdirSync(scope)) {
  const model = join(scope, lang, "4.0.0_best_int", `${lang}.traineddata.gz`);
  if (!existsSync(model)) throw new Error(`vendor: @tesseract.js-data/${lang} has no LSTM model; uninstall it`);
  files.push([model, `tessdata/${lang}.traineddata.gz`]);
}
for (const [from, to] of files) {
  mkdirSync(dirname(join(out, to)), { recursive: true });
  copyFileSync(from, join(out, to));
}
console.log(`vendor: ${files.length} files`);

// pdf.js data: character maps (CJK text in PDFs without embedded fonts),
// the standard 14 fonts, WASM image decoders (JPEG 2000, JBIG2) and the
// CMYK colour profile.
for (const dir of ["cmaps", "standard_fonts", "wasm", "iccs"]) {
  cpSync(join(pkgDir("pdfjs-dist"), dir), join(out, "pdfjs", dir), { recursive: true });
}
console.log("vendor: pdfjs data");

// Noto fonts for text the PDF tools add (page numbers, watermarks, the
// editor, form fields) in scripts Helvetica can't encode. Fontsource slices
// each font by Unicode range, so the browser only fetches the slices a piece
// of text needs. fonts.json lists every slice in priority order per group;
// src/lib/pdf/fonts.ts picks from it.
const fontGroups = {
  base: ["noto-sans", null], // Latin, Greek, Cyrillic, Vietnamese, Devanagari
  arabic: ["noto-sans-arabic", /-arabic-\d/],
  thai: ["noto-sans-thai", /-thai-\d/],
  // CJK fonts are sliced into numbered chunks; their named Latin and Cyrillic
  // slices duplicate the base font.
  sc: ["noto-sans-sc", /-sc-\d+-\d/],
  tc: ["noto-sans-tc", /-tc-\d+-\d/],
  jp: ["noto-sans-jp", /-jp-\d+-\d/],
  kr: ["noto-sans-kr", /-kr-\d+-\d/],
};
const fontsOut = join(out, "fonts");
mkdirSync(fontsOut, { recursive: true });
const manifest = {};
let fontFiles = 0;
for (const [group, [pkg, only]] of Object.entries(fontGroups)) {
  const dir = pkgDir(`@fontsource/${pkg}`);
  manifest[group] = [];
  for (const weight of [400, 700]) {
    const css = readFileSync(join(dir, `${weight}.css`), "utf8");
    // WOFF, not WOFF2: fontkit can't subset composite glyphs out of WOFF2's
    // transformed glyf table, and Devanagari uses them.
    for (const face of css.matchAll(/url\(\.\/files\/([^)]+\.woff)\)[\s\S]*?unicode-range:\s*([^;]+);/g)) {
      const [, file, range] = face;
      if (only && !only.test(file)) continue;
      // "U+0-ff,U+131" → [0, 255, 305, 305], flat pairs.
      const ranges = range.split(",").flatMap((r) => {
        const [lo, hi = lo] = r.trim().replace(/^U\+/i, "").split("-");
        return [parseInt(lo, 16), parseInt(hi, 16)];
      });
      writeFileSync(join(fontsOut, file), padWoff(readFileSync(join(dir, "files", file))));
      manifest[group].push({ file, weight, ranges });
      fontFiles++;
    }
  }
}
writeFileSync(join(fontsOut, "fonts.json"), JSON.stringify(manifest));
console.log(`vendor: ${fontFiles} font slices`);

// LibreOffice for high-fidelity Office → PDF (src/lib/office/libreoffice.ts).
// soffice.wasm and soffice.data are 147 MB and 100 MB; gzipped and cut into
// 20 MiB parts they fit hosts with a 25 MiB file limit (Cloudflare Pages).
// The browser joins and unzips them. Gzipping takes a while, so the parts
// are cached in node_modules/.cache per package version.
{
  const pkg = pkgDir("@matbee/libreoffice-converter");
  const pkgVersion = JSON.parse(readFileSync(join(pkg, "package.json"), "utf8")).version;
  const cache = join(process.cwd(), "node_modules", ".cache", "nopload-libreoffice", pkgVersion);
  const loOut = join(out, "libreoffice");
  mkdirSync(loOut, { recursive: true });
  const PART = 20 * 1024 * 1024;
  const manifest = { version: pkgVersion, files: {} };
  for (const name of ["soffice.wasm", "soffice.data"]) {
    const gz = join(cache, `${name}.gz`);
    if (!existsSync(gz)) {
      mkdirSync(cache, { recursive: true });
      writeFileSync(gz, gzipSync(readFileSync(join(pkg, "wasm", name)), { level: 6 }));
    }
    const data = readFileSync(gz);
    const parts = [];
    for (let i = 0, n = 0; i < data.length; i += PART, n++) {
      const part = `${name}.gz.${String(n).padStart(2, "0")}`;
      writeFileSync(join(loOut, part), data.subarray(i, i + PART));
      parts.push(part);
    }
    manifest.files[name] = { parts, size: data.length };
  }
  for (const [from, to] of [["wasm/soffice.js", "soffice.js"], ["wasm/soffice.worker.js", "soffice.worker.js"]])
    copyFileSync(join(pkg, from), join(loOut, to));
  // The converter's worker turns on every LibreOffice log (SAL_LOG=+ALL) and
  // prints it all to the console: thousands of lines a second during a
  // conversion, each a task on the page's main thread, which then can't
  // answer a click (Cancel) for tens of seconds. Warnings and errors only, and
  // LibreOffice's own output kept out of the console.
  let worker = readFileSync(join(pkg, "dist/browser.worker.global.js"), "utf8");
  for (const [from, to] of [['a.ENV.SAL_LOG="+ALL"', 'a.ENV.SAL_LOG="-INFO-WARN"'], ["print:console.log,printErr:console.error}", "print:()=>{},printErr:()=>{}}"]]) {
    if (!worker.includes(from)) throw new Error(`vendor: LibreOffice's browser worker changed; ${from} not found`);
    worker = worker.replace(from, to);
  }
  writeFileSync(join(loOut, "browser.worker.js"), worker);
  writeFileSync(join(loOut, "manifest.json"), JSON.stringify(manifest));
  console.log(`vendor: LibreOffice ${pkgVersion}, ${Object.values(manifest.files).reduce((n, f) => n + f.parts.length, 0)} parts`);
}

// On-device AI (src/lib/ai/): ONNX Runtime Web as Transformers.js pins it,
// in its WebGPU build (which also runs on the CPU). The 27 MB .wasm is
// gzipped to fit one file under the host's limit; the browser unzips it.
// (Its "exports" hide package.json; the main file is in dist/.)
const aiOrt = join(dirname(dirname(require.resolve("@huggingface/transformers"))), "node_modules", "onnxruntime-web");
{
  const aiOut = join(out, "ai");
  mkdirSync(aiOut, { recursive: true });
  copyFileSync(join(aiOrt, "dist", "ort-wasm-simd-threaded.asyncify.mjs"), join(aiOut, "ort-wasm-simd-threaded.asyncify.mjs"));
  writeFileSync(join(aiOut, "ort-wasm-simd-threaded.asyncify.wasm.gz"), gzipSync(readFileSync(join(aiOrt, "dist", "ort-wasm-simd-threaded.asyncify.wasm")), { level: 9 }));
  console.log("vendor: AI runtime");
}

// AI model weights, pinned by revision and SHA-256 in src/lib/ai/models.json.
// They aren't on npm, so they're downloaded once from Hugging Face into
// node_modules/.cache and checked. The site serves them from
// public/vendor/models/<model>-<revision>/ (outside the hashed folder, so a
// library update doesn't make visitors download them again), every file cut
// into parts under the host's file limit, with parts.json listing each
// part's hash. Visitors fetch them only after opting in (src/lib/ai/store.ts).
// NOPLOAD_AI_MODELS picks which go in: "all" (default), "none", or a comma
// list of model ids (CI uses "light").
const aiModels = [];
{
  const { partBytes, models } = JSON.parse(readFileSync(join(process.cwd(), "src", "lib", "ai", "models.json"), "utf8"));
  const wanted = (process.env.NOPLOAD_AI_MODELS ?? "all").split(",").map((s) => s.trim());
  const modelsRoot = join(root, "models");
  mkdirSync(modelsRoot, { recursive: true });
  const sha = (buf) => createHash("sha256").update(buf).digest("hex");
  // A pinned file from the cache, downloaded and checked first if need be.
  const pinned = async (repo, revision, file, [hash, size]) => {
    const cached = join(process.cwd(), "node_modules", ".cache", "nopload-models", repo, revision, file);
    if (!existsSync(cached)) {
      const url = `https://huggingface.co/${repo}/resolve/${revision}/${file}`;
      console.log(`vendor: downloading ${url} (${(size / 1048576).toFixed(1)} MiB)`);
      const res = await fetch(url);
      if (!res.ok) throw new Error(`vendor: ${url}: HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length !== size || sha(buf) !== hash) throw new Error(`vendor: ${url} doesn't match its pinned size and SHA-256`);
      mkdirSync(dirname(cached), { recursive: true });
      writeFileSync(cached + ".part", buf);
      renameSync(cached + ".part", cached);
    }
    const buf = readFileSync(cached);
    if (buf.length !== size || sha(buf) !== hash) throw new Error(`vendor: ${cached} is corrupt; delete it and install again`);
    return buf;
  };
  for (const [id, m] of Object.entries(models)) {
    if (!wanted.includes("all") && !wanted.includes(id)) continue;
    const dir = join(modelsRoot, `${id}-${m.revision.slice(0, 12)}`);
    const parts = {};
    for (const [file, pin] of Object.entries(m.files)) {
      const buf = await pinned(m.repo, m.revision, file, pin);
      mkdirSync(dirname(join(dir, file)), { recursive: true });
      parts[file] = [];
      for (let i = 0; i === 0 || i < buf.length; i += partBytes) {
        const chunk = buf.subarray(i, i + partBytes);
        writeFileSync(join(dir, `${file}.${String(parts[file].length).padStart(2, "0")}`), chunk);
        parts[file].push(sha(chunk));
      }
    }
    writeFileSync(join(dir, "parts.json"), JSON.stringify(parts));
    const licenseText = m.licenseFile ? (await pinned(m.licenseFile[0], m.licenseFile[1], m.licenseFile[2], m.licenseFile.slice(3))).toString("utf8").trim() : null;
    aiModels.push({ id, ...m, licenseText });
  }
  console.log(`vendor: AI models: ${aiModels.map((m) => m.id).join(", ") || "none"}`);
}

// Licences of everything the browser gets, for the licences page
// (/{lang}/licenses), in public/vendor/licenses/<hash>/. <component>.txt
// holds the licence and notice files of each package above, plus those of the
// projects compiled into them; libraries.txt those of the libraries bundled
// into the page code. A package that ships no licence file gets the standard
// text of the licence its package.json names, from scripts/licenses/, which
// also holds the notices of compiled-in projects. licenses.json lists it all.
const licRoot = join(root, "licenses");
const licOut = join(licRoot, "staging");
{
  mkdirSync(licOut, { recursive: true });
  const committed = (file) => readFileSync(join(process.cwd(), "scripts", "licenses", file), "utf8").trim();
  const standard = (id) => (existsSync(join(process.cwd(), "scripts", "licenses", `${id}.txt`)) ? committed(`${id}.txt`) : null);
  const joined = (texts) => texts.map(([f, body]) => (texts.length > 1 ? `--- ${f}\n\n` : "") + body).join("\n\n");
  const info = (name, from = process.cwd()) => {
    // Found the way Node would, without require.resolve (which "exports" can block).
    for (let d = from; ; d = dirname(d)) {
      const file = join(d, "node_modules", name, "package.json");
      if (existsSync(file)) return { dir: dirname(file), ...JSON.parse(readFileSync(file, "utf8")) };
      if (d === dirname(d)) throw new Error(`vendor: ${name} not installed`);
    }
  };
  // Where a package's repository field doesn't lead to the source.
  const sourceOf = {
    // Names a repository that doesn't exist (404); npm has the files.
    "pdfmarkdown-ppocrv5-models": (p) => `https://www.npmjs.com/package/${p.name}`,
    // MPL-2.0 §3.2: the build recipe and patches of this very version.
    "@matbee/libreoffice-converter": (p) => `https://github.com/matbeedotcom/libreoffice-document-converter/tree/v${p.version}`,
  };
  const source = (p) => {
    if (sourceOf[p.name]) return sourceOf[p.name](p);
    const repo = (typeof p.repository === "string" ? p.repository : p.repository?.url ?? "")
      .replace(/^git\+/, "").replace(/^git:\/\//, "https://").replace(/^ssh:\/\/git@/, "https://").replace(/\.git$/, "");
    if (/^https:\/\//.test(repo)) return repo;
    if (/^(github:)?[\w.-]+\/[\w.-]+$/.test(repo)) return `https://github.com/${repo.replace(/^github:/, "")}`;
    return /^https:\/\//.test(p.homepage ?? "") ? p.homepage : `https://www.npmjs.com/package/${p.name}`;
  };
  const licence = (p) => (typeof p.license === "string" ? p.license : p.license?.type ?? p.licenses?.[0]?.type ?? "unknown");
  // A package's own licence files (and any extra ones), else the standard text.
  const text = (p, extra = []) => {
    const own = readdirSync(p.dir).filter((f) => /^(licen[cs]e|notice|copying)/i.test(f)).sort();
    const body = joined([...own, ...extra].map((f) => [f, readFileSync(join(p.dir, f), "utf8").trim()]));
    if (body) return body;
    if (licence(p) === "unknown") return `The package names no licence in its package.json and includes no licence file. See ${source(p)}.`;
    const std = standard(licence(p).replace(/^MIT\/X11$/, "MIT"));
    return `The package declares ${licence(p)} in its package.json and includes no licence file.` + (std ? ` The standard text follows.\n\n${std}` : "");
  };
  const section = (title, body) => `=== ${title} ===\n\n${body}\n`;

  // The LibreOffice commit the converter's WebAssembly was built from, as the
  // version.ini packed into soffice.data records it.
  const loData = readFileSync(join(pkgDir("@matbee/libreoffice-converter"), "wasm", "soffice.data"));
  const loAt = loData.indexOf("buildid=");
  const loCommit = loAt < 0 ? null : /^buildid=([0-9a-f]{40})/.exec(loData.toString("latin1", loAt, loAt + 48))?.[1];
  if (!loCommit) console.warn("vendor: no LibreOffice build id in soffice.data, so its source link names no commit");

  // The libheif and libde265 versions in libheif.wasm, which records both as
  // plain strings. Update these with libheif-js; a mismatch stops the build.
  const HEIF_VERSIONS = { libheif: "1.23.2", libde265: "1.0.15" };
  const heifWasm = readFileSync(join(pkgDir("libheif-js"), "libheif-wasm", "libheif.wasm"));
  for (const [name, v] of Object.entries(HEIF_VERSIONS))
    if (!heifWasm.includes(`\0${v}\0`)) throw new Error(`vendor: libheif.wasm doesn't contain ${name} ${v}; update HEIF_VERSIONS`);

  // Everything served from /vendor, by component, with the projects each one
  // compiles in: [name, licence, source, texts in scripts/licenses/ that the
  // package itself doesn't ship].
  const fonts = (names) => names.map((n) => [`@fontsource/${n}`]);
  const components = [
    { name: "PDF.js", file: "pdfjs.txt", packages: [["pdfjs-dist"]] },
    {
      name: "qpdf", file: "qpdf.txt", packages: [["@neslinesli93/qpdf-wasm"]],
      includes: [["qpdf", "Apache-2.0", "https://github.com/qpdf/qpdf", ["qpdf-NOTICE.md", "Apache-2.0.txt"]]],
    },
    { name: "MozJPEG", file: "mozjpeg.txt", packages: [["@jsquash/jpeg", ["codec/LICENSE.codec.md"]]], includes: [["MozJPEG", "IJG AND BSD-3-Clause AND Zlib", "https://github.com/mozilla/mozjpeg"]] },
    { name: "PDFium", file: "pdfium.txt", packages: [["@embedpdf/pdfium"]], includes: [["PDFium", "BSD-3-Clause", "https://pdfium.googlesource.com/pdfium/"]] },
    {
      name: "Tesseract", file: "tesseract.txt", packages: [["tesseract.js"], ["tesseract.js-core"]],
      includes: [
        ["Tesseract", "Apache-2.0", "https://github.com/tesseract-ocr/tesseract"],
        ["Leptonica", "BSD-2-Clause", "https://github.com/DanBloomberg/leptonica", ["leptonica-license.txt"]],
      ],
    },
    {
      name: "Tesseract language data", file: "tessdata.txt", packages: readdirSync(scope).sort().map((l) => [`@tesseract.js-data/${l}`]),
      includes: [["tessdata_best", "Apache-2.0", "https://github.com/tesseract-ocr/tessdata_best", ["Apache-2.0.txt"]]],
    },
    { name: "ONNX Runtime Web", file: "onnxruntime.txt", packages: [["onnxruntime-web"]], includes: [["ONNX Runtime", "MIT", "https://github.com/microsoft/onnxruntime"]] },
    { name: "PaddleOCR models", file: "paddleocr.txt", packages: [["pdfmarkdown-ppocrv5-models"]], includes: [["PaddleOCR PP-OCRv5", "Apache-2.0", "https://github.com/PaddlePaddle/PaddleOCR"]] },
    // MPL-2.0 §3.2: say where the source of the WebAssembly build is.
    {
      name: "LibreOffice", file: "libreoffice.txt", packages: [["@matbee/libreoffice-converter"]],
      includes: [["LibreOffice", "MPL-2.0", `https://git.libreoffice.org/core${loCommit ? `/+/${loCommit}` : ""}`, ["MPL-2.0.txt"]]],
    },
    // On-device AI: the runtime, with ONNX Runtime Web as Transformers.js pins it.
    {
      name: "Transformers.js", file: "transformers.txt", packages: [["@huggingface/transformers"], ["onnxruntime-web", [], aiOrt]],
      includes: [["ONNX Runtime", "MIT", "https://github.com/microsoft/onnxruntime"]],
    },
    // LGPL-3.0: the source of the exact versions compiled in, their copyright
    // notices, and (§4(b)) the GNU GPL-3.0 text as well as the LGPL's.
    // libheif-wasm/LICENSE is libheif's own COPYING (LGPL-3.0, GPL-3.0, MIT).
    // Update the NOTICE files and libde265-COPYING.txt with HEIF_VERSIONS.
    {
      name: "libheif", file: "libheif.txt", packages: [["libheif-js", ["libheif-wasm/LICENSE"]]],
      includes: [
        ["libheif", "LGPL-3.0", `https://github.com/strukturag/libheif/tree/v${HEIF_VERSIONS.libheif}`, ["libheif-NOTICE.txt"]],
        ["libde265", "LGPL-3.0", `https://github.com/strukturag/libde265/tree/v${HEIF_VERSIONS.libde265}`, ["libde265-NOTICE.txt", "libde265-COPYING.txt"]],
      ],
    },
    { name: "Noto Sans", file: "noto.txt", packages: fonts(Object.keys(fontGroups).map((g) => fontGroups[g][0])) },
    { name: "Arimo, Tinos, Cousine, Carlito, Caladea", file: "pdfa-fonts.txt", packages: fonts(["arimo", "tinos", "cousine", "carlito", "caladea"]) },
    { name: "Dancing Script, Great Vibes, Caveat", file: "signature-fonts.txt", packages: fonts(["dancing-script", "great-vibes", "caveat"]) },
  ];
  const listed = new Set();
  const json = { components: [], libraries: [], librariesFile: "libraries.txt" };
  for (const c of components) {
    const parts = [];
    const packages = c.packages.map(([name, extra, from]) => {
      const p = info(name, from);
      listed.add(p.name);
      parts.push(section(`${p.name} ${p.version} (${licence(p)}), ${source(p)}`, text(p, extra)));
      return { name: p.name, version: p.version, license: licence(p), source: source(p) };
    });
    const includes = (c.includes ?? []).map(([name, license, src, texts]) => {
      parts.push(section(`Includes ${name} (${license}), source code: ${src}`, texts ? joined(texts.map((f) => [f, committed(f)])) : `See ${src} for its licence.`));
      return { name, license, source: src };
    });
    writeFileSync(join(licOut, c.file), parts.join("\n"));
    json.components.push({ name: c.name, file: c.file, packages, includes });
  }
  // The site's own font, which Next serves from /_next.
  writeFileSync(join(licOut, "geist.txt"), section("Geist (OFL-1.1), https://github.com/vercel/geist-font", readFileSync(join(process.cwd(), "src/app/fonts/LICENSE-Geist.txt"), "utf8").trim()));
  // AI models in this build: their licence, and where they come from.
  if (aiModels.length) {
    const file = "ai-models.txt";
    writeFileSync(join(licOut, file), aiModels.map((m) => section(`${m.name} (${m.license}), ${m.upstream}, ONNX weights from https://huggingface.co/${m.repo}/tree/${m.revision}`, m.licenseText ?? committed(`${m.license}.txt`))).join("\n"));
    json.components.push({ name: "On-device AI models", file, packages: [], includes: aiModels.map((m) => ({ name: m.name, license: m.license, source: m.upstream })) });
  }
  json.components.push({ name: "Geist", file: "geist.txt", packages: [], includes: [{ name: "Geist", license: "OFL-1.1", source: "https://github.com/vercel/geist-font" }] });

  // Libraries in the page code: the dependency tree of every runtime
  // dependency except server-only ones, less the packages listed above.
  // Optional dependencies are platform builds (compilers, image tools), not
  // page code.
  const serverOnly = new Set(["bcryptjs", "jose", "playwright-core", "server-only"]);
  const libs = new Map();
  const walk = (name, from) => {
    const p = info(name, from);
    const key = `${p.name}@${p.version}`;
    if (libs.has(key)) return;
    libs.set(key, p);
    for (const dep of Object.keys(p.dependencies ?? {})) walk(dep, p.dir);
  };
  const app = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8"));
  for (const dep of Object.keys(app.dependencies)) if (!serverOnly.has(dep)) walk(dep, process.cwd());
  const sorted = [...libs.values()].filter((p) => !listed.has(p.name)).sort((a, b) => (a.name === b.name ? (a.version < b.version ? -1 : 1) : a.name < b.name ? -1 : 1));
  writeFileSync(join(licOut, json.librariesFile), sorted.map((p) => section(`${p.name} ${p.version} (${licence(p)}), ${source(p)}`, text(p))).join("\n"));
  json.libraries = sorted.map((p) => ({ name: p.name, version: p.version, license: licence(p), source: source(p) }));
  writeFileSync(join(licOut, "licenses.json"), JSON.stringify(json));
  console.log(`vendor: licences for ${json.components.length} components and ${json.libraries.length} libraries`);
}

const version = hashOf(out);
renameSync(out, join(root, version));
const licVersion = hashOf(licOut);
renameSync(licOut, join(licRoot, licVersion));
writeFileSync(
  join(process.cwd(), "src", "lib", "vendor.ts"),
  `// Generated by scripts/vendor.mjs on install. Do not edit or commit.
export const VENDOR_VERSION = "${version}";
export const VENDOR = "/vendor/${version}/";
export const LICENSES = "/vendor/licenses/${licVersion}/";
// The AI models this build serves (src/lib/ai/models.json), under /vendor/models/.
export const AI_MODELS: string[] = ${JSON.stringify(aiModels.map((m) => m.id))};
`,
);
console.log(`vendor: public/vendor/${version}/, public/vendor/licenses/${licVersion}/`);
