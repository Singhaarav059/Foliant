// Copies runtime assets the browser loads by URL into public/vendor, so their
// versions always match the installed packages and nothing is fetched from a
// CDN. Runs on postinstall.
//
// Files land in public/vendor/<hash>/, where the hash covers their contents,
// and src/lib/vendor.ts (generated, not committed) exports that path. New
// package versions therefore get new URLs, so neither the service worker nor
// a browser cache can pair new page code with an old worker or WASM file.
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
for (const family of ["arimo", "tinos", "cousine", "carlito", "caladea"])
  for (const weight of [400, 700])
    for (const style of ["normal", "italic"]) {
      const file = `${family}-latin-${weight}-${style}.woff`;
      files.push([join(pkgDir(`@fontsource/${family}`), "files", file), `pdfa-fonts/${file}`]);
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
// Tesseract picks one of these by the browser's SIMD support. OCR runs the
// LSTM engine only, so the legacy-engine builds aren't needed.
for (const f of ["tesseract-core-lstm.wasm.js", "tesseract-core-simd-lstm.wasm.js", "tesseract-core-relaxedsimd-lstm.wasm.js"]) {
  files.push([join(pkgDir("tesseract.js-core"), f), `tesseract/${f}`]);
}
// OCR languages: the gzipped "best_int" LSTM models, the same files the
// tesseract.js CDN serves by default. Every @tesseract.js-data/* dependency
// is picked up, so adding a language is one npm install plus OCR_LANGS.
const scope = join(dirname(pkgDir("@tesseract.js-data/eng")));
for (const lang of readdirSync(scope)) {
  files.push([join(scope, lang, "4.0.0_best_int", `${lang}.traineddata.gz`), `tessdata/${lang}.traineddata.gz`]);
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
  const cache = join(process.cwd(), "node_modules", ".cache", "foliant-libreoffice", pkgVersion);
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
  for (const [from, to] of [["wasm/soffice.js", "soffice.js"], ["wasm/soffice.worker.js", "soffice.worker.js"], ["dist/browser.worker.global.js", "browser.worker.js"]])
    copyFileSync(join(pkg, from), join(loOut, to));
  writeFileSync(join(loOut, "manifest.json"), JSON.stringify(manifest));
  console.log(`vendor: LibreOffice ${pkgVersion}, ${Object.values(manifest.files).reduce((n, f) => n + f.parts.length, 0)} parts`);
}

// Licences of everything the browser gets, for the licences page
// (/{lang}/licenses). licenses/<component>.txt holds the licence and notice
// files of each package above, plus those of the projects compiled into them;
// licenses/libraries.txt those of the libraries bundled into the page code.
// A package that ships no licence file gets the standard text of the licence
// its package.json names, from scripts/licenses/. licenses.json lists it all.
{
  const licOut = join(out, "licenses");
  mkdirSync(licOut, { recursive: true });
  const standard = (id) => {
    const file = join(process.cwd(), "scripts", "licenses", `${id}.txt`);
    return existsSync(file) ? readFileSync(file, "utf8").trim() : null;
  };
  const info = (name, from = process.cwd()) => {
    // Found the way Node would, without require.resolve (which "exports" can block).
    for (let d = from; ; d = dirname(d)) {
      const file = join(d, "node_modules", name, "package.json");
      if (existsSync(file)) return { dir: dirname(file), ...JSON.parse(readFileSync(file, "utf8")) };
      if (d === dirname(d)) throw new Error(`vendor: ${name} not installed`);
    }
  };
  const source = (p) => {
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
    const files = [...own, ...extra];
    const body = files.map((f) => (files.length > 1 ? `--- ${f}\n\n` : "") + readFileSync(join(p.dir, f), "utf8").trim()).join("\n\n");
    if (body) return body;
    if (licence(p) === "unknown") return `The package names no licence in its package.json and includes no licence file. See ${source(p)}.`;
    const std = standard(licence(p).replace(/^MIT\/X11$/, "MIT"));
    return `The package declares ${licence(p)} in its package.json and includes no licence file.` + (std ? ` The standard text follows.\n\n${std}` : "");
  };
  const section = (title, body) => `=== ${title} ===\n\n${body}\n`;

  // Everything served from /vendor, by component, with the projects each one
  // compiles in: [name, licence, source, text of that licence if not in the package].
  const fonts = (names) => names.map((n) => [`@fontsource/${n}`]);
  const components = [
    { name: "PDF.js", file: "pdfjs.txt", packages: [["pdfjs-dist"]] },
    { name: "qpdf", file: "qpdf.txt", packages: [["@neslinesli93/qpdf-wasm"]], includes: [["qpdf", "Apache-2.0", "https://github.com/qpdf/qpdf", "Apache-2.0"]] },
    { name: "MozJPEG", file: "mozjpeg.txt", packages: [["@jsquash/jpeg", ["codec/LICENSE.codec.md"]]], includes: [["MozJPEG", "IJG AND BSD-3-Clause AND Zlib", "https://github.com/mozilla/mozjpeg"]] },
    { name: "PDFium", file: "pdfium.txt", packages: [["@embedpdf/pdfium"]], includes: [["PDFium", "BSD-3-Clause", "https://pdfium.googlesource.com/pdfium/"]] },
    {
      name: "Tesseract", file: "tesseract.txt", packages: [["tesseract.js"], ["tesseract.js-core"]],
      includes: [["Tesseract", "Apache-2.0", "https://github.com/tesseract-ocr/tesseract"], ["Leptonica", "BSD-2-Clause", "https://github.com/DanBloomberg/leptonica"]],
    },
    {
      name: "Tesseract language data", file: "tessdata.txt", packages: readdirSync(scope).sort().map((l) => [`@tesseract.js-data/${l}`]),
      includes: [["tessdata_best", "Apache-2.0", "https://github.com/tesseract-ocr/tessdata_best", "Apache-2.0"]],
    },
    { name: "ONNX Runtime Web", file: "onnxruntime.txt", packages: [["onnxruntime-web"]], includes: [["ONNX Runtime", "MIT", "https://github.com/microsoft/onnxruntime"]] },
    { name: "PaddleOCR models", file: "paddleocr.txt", packages: [["pdfmarkdown-ppocrv5-models"]], includes: [["PaddleOCR PP-OCRv5", "Apache-2.0", "https://github.com/PaddlePaddle/PaddleOCR"]] },
    // MPL-2.0 §3.2: say where the source of the WebAssembly build is.
    {
      name: "LibreOffice", file: "libreoffice.txt", packages: [["@matbee/libreoffice-converter"]],
      includes: [["LibreOffice", "MPL-2.0", "https://git.libreoffice.org/core", "MPL-2.0"]],
    },
    { name: "Noto Sans", file: "noto.txt", packages: fonts(Object.keys(fontGroups).map((g) => fontGroups[g][0])) },
    { name: "Arimo, Tinos, Cousine, Carlito, Caladea", file: "pdfa-fonts.txt", packages: fonts(["arimo", "tinos", "cousine", "carlito", "caladea"]) },
  ];
  const listed = new Set();
  const json = { components: [], libraries: [], librariesFile: "libraries.txt" };
  for (const c of components) {
    const parts = [];
    const packages = c.packages.map(([name, extra]) => {
      const p = info(name);
      listed.add(p.name);
      parts.push(section(`${p.name} ${p.version} (${licence(p)}), ${source(p)}`, text(p, extra)));
      return { name: p.name, version: p.version, license: licence(p), source: source(p) };
    });
    const includes = (c.includes ?? []).map(([name, license, src, std]) => {
      parts.push(section(`Includes ${name} (${license}), source code: ${src}`, std ? standard(std) : `See ${src} for its licence.`));
      return { name, license, source: src };
    });
    writeFileSync(join(licOut, c.file), parts.join("\n"));
    json.components.push({ name: c.name, file: c.file, packages, includes });
  }
  // The site's own font, which Next serves from /_next.
  writeFileSync(join(licOut, "geist.txt"), section("Geist (OFL-1.1), https://github.com/vercel/geist-font", readFileSync(join(process.cwd(), "src/app/fonts/LICENSE-Geist.txt"), "utf8").trim()));
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

// Content hash of everything above, in a stable file order.
const hash = createHash("sha256");
const walk = (dir) => readdirSync(dir, { withFileTypes: true })
  .sort((a, b) => (a.name < b.name ? -1 : 1))
  .forEach((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return walk(p);
    hash.update(p.slice(out.length)).update(readFileSync(p));
  });
walk(out);
const version = hash.digest("hex").slice(0, 12);
renameSync(out, join(root, version));
writeFileSync(
  join(process.cwd(), "src", "lib", "vendor.ts"),
  `// Generated by scripts/vendor.mjs on install. Do not edit or commit.\nexport const VENDOR_VERSION = "${version}";\nexport const VENDOR = "/vendor/${version}/";\n`,
);
console.log(`vendor: public/vendor/${version}/`);
