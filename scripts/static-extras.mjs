// Finishes the static build in ./out (npm run build:static):
// - _headers: security and caching headers, for hosts that read the file
//   (Cloudflare Pages, Netlify). The server build sets the same ones in
//   next.config.ts.
// - 404.html: the language picker, so links without a language prefix still
//   land. Missing pages inside a language get /{lang}/404.html on hosts that
//   look for the nearest one.
// - .nojekyll: GitHub Pages otherwise runs Jekyll, which drops every path
//   that starts with "_", including all of _next/.
// Then it fails the build if the site wouldn't deploy to Cloudflare Pages'
// free plan (20,000 files, 25 MiB per file), with some headroom.
// Usage: node scripts/static-extras.mjs [dir=out]
import { copyFileSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const out = resolve(process.argv[2] ?? "out");
const security = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../security-headers.json"), "utf8"));

const rules = [
  ["/*", security.map((h) => `${h.key}: ${h.value}`)],
  ["/sw.js", ["Cache-Control: no-cache"]],
  ["/_next/static/*", ["Cache-Control: public, max-age=31536000, immutable"]],
  // Content-hashed by scripts/vendor.mjs.
  ["/vendor/*", ["Cache-Control: public, max-age=31536000, immutable"]],
];
writeFileSync(join(out, "_headers"), rules.map(([path, lines]) => [path, ...lines.map((l) => `  ${l}`)].join("\n")).join("\n\n") + "\n");
copyFileSync(join(out, "index.html"), join(out, "404.html"));
writeFileSync(join(out, ".nojekyll"), "");
console.log("static: wrote out/_headers, out/404.html and out/.nojekyll");

const MAX_FILES = 18000;
const MAX_FILE_BYTES = 24 * 1024 * 1024;
const files = readdirSync(out, { recursive: true }).map((f) => join(out, f)).filter((f) => statSync(f).isFile());
const sizes = files.map((f) => statSync(f).size);
const largest = sizes.indexOf(Math.max(...sizes));
const mib = (n) => `${(n / 1024 / 1024).toFixed(1)} MiB`;
console.log(`static: ${files.length} files, ${mib(sizes.reduce((a, b) => a + b, 0))}, largest ${relative(out, files[largest])} (${mib(sizes[largest])})`);
const tooBig = files.filter((_, i) => sizes[i] > MAX_FILE_BYTES);
const problems = [
  ...(files.length > MAX_FILES ? [`${files.length} files; keep it under ${MAX_FILES} (Cloudflare Pages allows 20,000)`] : []),
  ...tooBig.map((f) => `${relative(out, f)} is ${mib(statSync(f).size)}; keep files under ${mib(MAX_FILE_BYTES)} (Cloudflare Pages allows 25 MiB)`),
];
for (const p of problems) console.error(`static: ${p}`);
if (problems.length) process.exit(1);
