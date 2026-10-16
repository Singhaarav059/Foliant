// Copies runtime assets the browser loads by URL into public/vendor, so their
// versions always match the installed packages. Runs on postinstall.
import { copyFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const out = join(process.cwd(), "public", "vendor");
mkdirSync(out, { recursive: true });

const pkgDir = (name) => dirname(require.resolve(`${name}/package.json`));

const files = [
  [join(pkgDir("pdfjs-dist"), "build", "pdf.worker.min.mjs"), "pdf.worker.min.mjs"],
  [join(pkgDir("@neslinesli93/qpdf-wasm"), "dist", "qpdf.wasm"), "qpdf.wasm"],
];
for (const [from, to] of files) {
  copyFileSync(from, join(out, to));
  console.log(`vendor: ${to}`);
}
