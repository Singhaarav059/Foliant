// Finishes the static build in ./out (npm run build:static):
// - _headers: security and caching headers, for hosts that read the file
//   (Cloudflare Pages, Netlify). The server build sets the same ones in
//   next.config.ts.
// (404.html is rendered by Next from src/app/global-not-found.static.tsx;
// missing pages inside a language get /{lang}/404.html on hosts that look for
// the nearest one. sitemap.xml and robots.txt come from route handlers.)
// - .nojekyll: GitHub Pages otherwise runs Jekyll, which drops every path
//   that starts with "_", including all of _next/.
// - _redirects: 301s from the old English tool addresses (/es/merge-pdf) to
//   the localized ones (/es/unir-pdf, src/lib/i18n/slugs.ts), read from the
//   sitemap: a page whose English translation is a tool's English slug, at
//   another slug. Each old address also gets a small page that refreshes to
//   the new one and names it as canonical, for hosts without _redirects
//   (Cloudflare Pages follows _redirects before serving the file).
// - sw-manifest.json: what the service worker (public/sw.js) precaches for
//   offline use: the app shell every page loads, plus the full list of build
//   files so it can drop old ones. sw.js gets this build's id, so a deploy
//   installs a fresh worker.
// Then it fails the build if the site wouldn't deploy to Cloudflare Pages'
// free plan (20,000 files, 25 MiB per file, 2,000 static redirects), with
// some headroom for files.
// Usage: node scripts/static-extras.mjs [dir=out]
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const out = resolve(process.argv[2] ?? "out");
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const security = JSON.parse(readFileSync(join(root, "security-headers.json"), "utf8"));

const rules = [
  ["/*", security.map((h) => `${h.key}: ${h.value}`)],
  ["/sw.js", ["Cache-Control: no-cache"]],
  ["/sw-manifest.json", ["Cache-Control: no-cache"]],
  ["/_next/static/*", ["Cache-Control: public, max-age=31536000, immutable"]],
  // Content-hashed by scripts/vendor.mjs.
  ["/vendor/*", ["Cache-Control: public, max-age=31536000, immutable"]],
];
writeFileSync(join(out, "_headers"), rules.map(([path, lines]) => [path, ...lines.map((l) => `  ${l}`)].join("\n")).join("\n\n") + "\n");
writeFileSync(join(out, ".nojekyll"), "");

// Old address → new one, both paths, from the sitemap's <url> entries.
const MAX_REDIRECTS = 2000;
const toolSlugs = new Set([...readFileSync(join(root, "src/lib/tools.ts"), "utf8").matchAll(/\bslug: "([a-z0-9-]+)"/g)].map((m) => m[1]));
const moved = [];
const sitemapFile = join(out, "sitemap.xml");
for (const [, url] of existsSync(sitemapFile) ? readFileSync(sitemapFile, "utf8").matchAll(/<url>([\s\S]*?)<\/url>/g) : []) {
  const loc = url.match(/<loc>([^<]+)<\/loc>/)?.[1];
  const en = url.match(/<xhtml:link\b[^>]*hreflang="en"[^>]*href="([^"]+)"/)?.[1];
  if (!loc || !en) continue;
  const [, lang, slug] = new URL(loc).pathname.split("/");
  const old = new URL(en).pathname.split("/")[2];
  if (lang !== "en" && slug && toolSlugs.has(old) && old !== slug) moved.push({ from: `/${lang}/${old}`, to: `/${lang}/${slug}`, canonical: loc, lang });
}
const redirectProblems = [];
for (const { from, to, canonical, lang } of moved) {
  const file = join(out, `${from.slice(1)}.html`);
  if (existsSync(file)) {
    redirectProblems.push(`${relative(out, file)} is a page; it can't also redirect to ${to}`);
    continue;
  }
  const attr = (s) => s.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `<!doctype html><html lang="${attr(lang)}"><head><meta charset="utf-8"><title>${attr(to)}</title><link rel="canonical" href="${attr(canonical)}"><meta http-equiv="refresh" content="0; url=${attr(to)}"></head><body><a href="${attr(to)}">${attr(to)}</a></body></html>\n`);
}
if (moved.length) writeFileSync(join(out, "_redirects"), moved.map((m) => `${m.from} ${m.to} 301\n`).join(""));
if (moved.length > MAX_REDIRECTS) redirectProblems.push(`${moved.length} redirects; Cloudflare Pages takes ${MAX_REDIRECTS} static ones`);

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
const locales = [...readFileSync(join(root, "src/lib/i18n/locales.ts"), "utf8").matchAll(/code: "([\w-]+)"/g)].map((m) => m[1]);
const build = createHash("sha256").update(files.join("\n")).digest("hex").slice(0, 12);
writeFileSync(join(out, "sw-manifest.json"), JSON.stringify({ build, locales, shell: [...shell].sort(), files }));

const sw = join(out, "sw.js");
const source = readFileSync(sw, "utf8");
if (!source.includes('const BUILD = "dev";')) throw new Error("public/sw.js: BUILD placeholder not found");
writeFileSync(sw, source.replace('const BUILD = "dev";', `const BUILD = "${build}";`));

const kb = (urls) => Math.round([...urls].reduce((n, u) => n + readFileSync(join(out, u)).length, 0) / 1024);
console.log(`static: ${moved.length} old addresses redirect to localized ones`);
console.log(`static: wrote out/_headers, out/.nojekyll and out/sw-manifest.json (shell: ${shell.size} files, ${kb(shell)} KB; build ${build})`);

const MAX_FILES = 18000;
const MAX_FILE_BYTES = 24 * 1024 * 1024;
const all = readdirSync(out, { recursive: true }).map((f) => join(out, f)).filter((f) => statSync(f).isFile());
const sizes = all.map((f) => statSync(f).size);
const largest = sizes.indexOf(Math.max(...sizes));
const mib = (n) => `${(n / 1024 / 1024).toFixed(1)} MiB`;
console.log(`static: ${all.length} files, ${mib(sizes.reduce((a, b) => a + b, 0))}, largest ${relative(out, all[largest])} (${mib(sizes[largest])})`);
const tooBig = all.filter((_, i) => sizes[i] > MAX_FILE_BYTES);
const problems = [
  ...redirectProblems,
  ...(all.length > MAX_FILES ? [`${all.length} files; keep it under ${MAX_FILES} (Cloudflare Pages allows 20,000)`] : []),
  ...tooBig.map((f) => `${relative(out, f)} is ${mib(statSync(f).size)}; keep files under ${mib(MAX_FILE_BYTES)} (Cloudflare Pages allows 25 MiB)`),
];
for (const p of problems) console.error(`static: ${p}`);
if (problems.length) process.exit(1);
