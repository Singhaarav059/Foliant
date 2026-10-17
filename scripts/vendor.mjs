// Copies runtime assets the browser loads by URL into public/vendor, so their
// versions always match the installed packages and nothing is fetched from a
// CDN. Runs on postinstall.
//
// Files land in public/vendor/<hash>/, where the hash covers their contents,
// and src/lib/vendor.ts (generated, not committed) exports that path. New
// package versions therefore get new URLs, so neither the service worker nor
// a browser cache can pair new page code with an old worker or WASM file.
import { createHash } from "node:crypto";
import { copyFileSync, cpSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
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
