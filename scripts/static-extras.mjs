// Finishes the static build in ./out (npm run build:static):
// - _headers: security and caching headers, for hosts that read the file
//   (Cloudflare Pages, Netlify). The server build sets the same ones in
//   next.config.ts.
// - 404.html: the language picker, so links without a language prefix still
//   land. Missing pages inside a language get /{lang}/404.html on hosts that
//   look for the nearest one.
// - sw-manifest.json: what the service worker (public/sw.js) precaches for
//   offline use: the app shell every page loads, plus the full list of build
//   files so it can drop old ones. sw.js gets this build's id, so a deploy
//   installs a fresh worker.
import { createHash } from "node:crypto";
import { copyFileSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

const out = join(process.cwd(), "out");
const security = JSON.parse(readFileSync(join(process.cwd(), "security-headers.json"), "utf8"));

const rules = [
  ["/*", security.map((h) => `${h.key}: ${h.value}`)],
  ["/sw.js", ["Cache-Control: no-cache"]],
  ["/sw-manifest.json", ["Cache-Control: no-cache"]],
  ["/_next/static/*", ["Cache-Control: public, max-age=31536000, immutable"]],
  // Content-hashed by scripts/vendor.mjs.
  ["/vendor/*", ["Cache-Control: public, max-age=31536000, immutable"]],
];
writeFileSync(join(out, "_headers"), rules.map(([path, lines]) => [path, ...lines.map((l) => `  ${l}`)].join("\n")).join("\n\n") + "\n");
copyFileSync(join(out, "index.html"), join(out, "404.html"));

const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
const urlOf = (file) => "/" + relative(out, file).split(sep).join("/");

// Every build file, and the ones the pages themselves reference: their
// scripts, stylesheets and preloaded fonts. Fonts for other scripts (CJK,
// Arabic…) are only named in the CSS and load when a page needs them.
const files = walk(join(out, "_next/static")).map(urlOf).sort();
const known = new Set(files);
const shell = new Set();
for (const html of walk(out).filter((f) => f.endsWith(".html"))) {
  for (const [url] of readFileSync(html, "utf8").matchAll(/\/_next\/static\/[\w./~@-]+\.(?:js|css|woff2)/g)) {
    if (known.has(url)) shell.add(url);
  }
}
const locales = [...readFileSync(join(process.cwd(), "src/lib/i18n/locales.ts"), "utf8").matchAll(/code: "([\w-]+)"/g)].map((m) => m[1]);
const build = createHash("sha256").update(files.join("\n")).digest("hex").slice(0, 12);
writeFileSync(join(out, "sw-manifest.json"), JSON.stringify({ build, locales, shell: [...shell].sort(), files }));

const sw = join(out, "sw.js");
const source = readFileSync(sw, "utf8");
if (!source.includes('const BUILD = "dev";')) throw new Error("public/sw.js: BUILD placeholder not found");
writeFileSync(sw, source.replace('const BUILD = "dev";', `const BUILD = "${build}";`));

const kb = (urls) => Math.round([...urls].reduce((n, u) => n + readFileSync(join(out, u)).length, 0) / 1024);
console.log(`static: wrote out/_headers, out/404.html and out/sw-manifest.json (shell: ${shell.size} files, ${kb(shell)} KB; build ${build})`);
