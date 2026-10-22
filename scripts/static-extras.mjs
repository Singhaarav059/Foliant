// Finishes the static build in ./out (npm run build:static):
// - _headers: security and caching headers, for hosts that read the file
//   (Cloudflare Pages, Netlify). The server build sets the same ones in
//   next.config.ts.
// (404.html is rendered by Next from src/app/global-not-found.static.tsx;
// missing pages inside a language get /{lang}/404.html on hosts that look for
// the nearest one. sitemap.xml and robots.txt come from route handlers.)
// - A <meta> copy of the Content-Security-Policy in every page, for hosts
//   that ignore _headers.
// - .nojekyll: GitHub Pages otherwise runs Jekyll, which drops every path
//   that starts with "_", including all of _next/.
// - _redirects: 301s from the old English tool addresses (/es/merge-pdf) to
//   the localized ones (/es/unir-pdf, src/lib/i18n/slugs.ts), read from the
//   sitemap: a page whose English translation is a tool's English slug, at
//   another slug. Each old address also gets a small page that refreshes to
//   the new one and names it as canonical, for hosts without _redirects
//   (Cloudflare Pages follows _redirects before serving the file).
// - No .wasm twice: a library's own copy that Next put in _next/static/media
//   (pdfium, ONNX Runtime) is the same file the app loads from /vendor, so
//   the chunk's reference points there and the copy goes (P3-03).
// - sw-manifest.json: what the service worker (public/sw.js) precaches for
//   offline use: the app shell every page loads, plus the full list of build
//   files so it can drop old ones. sw.js gets this build's id, so a deploy
//   installs a fresh worker.
// Then it fails the build if a page loads anything from another site, or if
// the site wouldn't deploy to Cloudflare Pages' free plan (20,000 files,
// 25 MiB per file, 2,000 static redirects), with some headroom for files.
// Usage: node scripts/static-extras.mjs [dir=out]
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const out = resolve(process.argv[2] ?? "out");
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const security = JSON.parse(readFileSync(join(root, "security-headers.json"), "utf8"));

// LibreOffice's glue (embind) builds functions from strings, which the
// policy forbids. A worker's policy comes from its own response, so its
// scripts, and nothing else, get a copy that allows eval (see next.config.ts).
const csp = security.find((h) => h.key === "Content-Security-Policy")?.value;
if (!csp) throw new Error("security-headers.json: no Content-Security-Policy");
const rules = [
  ["/*", security.map((h) => `${h.key}: ${h.value}`)],
  ["/vendor/:build/libreoffice/*", ["! Content-Security-Policy", `Content-Security-Policy: ${csp.replace("script-src 'self'", "script-src 'self' 'unsafe-eval'")}`]],
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

// Large .wasm files Next copied into _next/static/media that /vendor already
// holds byte for byte: chunks are pointed at the vendor copy and the media
// copy is deleted, so the site doesn't ship (and count) them twice.
{
  const hash = (f) => createHash("sha256").update(readFileSync(f)).digest("hex");
  const vendored = new Map(walk(join(out, "vendor")).filter((f) => f.endsWith(".wasm")).map((f) => [hash(f), urlOf(f)]));
  const media = join(out, "_next", "static", "media");
  const dupes = existsSync(media) ? readdirSync(media).filter((f) => f.endsWith(".wasm")).map((f) => join(media, f)).filter((f) => statSync(f).size > 1 << 20 && vendored.has(hash(f))) : [];
  if (dupes.length) {
    const chunks = walk(join(out, "_next")).filter((f) => f.endsWith(".js"));
    for (const file of chunks) {
      let js = readFileSync(file, "utf8");
      const before = js;
      for (const d of dupes) js = js.replaceAll(urlOf(d), vendored.get(hash(d)));
      if (js !== before) writeFileSync(file, js);
    }
    for (const d of dupes) rmSync(d);
    console.log(`static: ${dupes.length} duplicate .wasm files now load from /vendor`);
  }
}

// The Content-Security-Policy as a <meta> tag too, first in every page's
// <head>, for hosts that ignore _headers (GitHub Pages). Browsers ignore
// frame-ancestors there, so it's left out; framing stays the header's job.
const metaCsp = `<meta http-equiv="Content-Security-Policy" content="${csp.split(/;\s*/).filter((d) => !d.startsWith("frame-ancestors")).join("; ")}"/>`;
const pages = walk(out).filter((f) => f.endsWith(".html"));
for (const file of pages) {
  const html = readFileSync(file, "utf8");
  const head = html.match(/<head(?:\s[^>]*)?>/i) ?? html.match(/^<!doctype html>/i);
  const at = head ? head.index + head[0].length : 0;
  writeFileSync(file, html.slice(0, at) + metaCsp + html.slice(at));
}

// Nothing the pages load may come from another site (the policy would block
// it anyway): scripts, images, frames, stylesheets and preloads in the HTML,
// and url()s in the CSS. Links and canonical URLs are only addresses.
const offsite = [];
const absolute = /^(?:https?:)?\/\//i;
for (const file of pages) {
  const html = readFileSync(file, "utf8");
  for (const [tag] of html.matchAll(/<(?:script|img|iframe|source|video|audio|embed|link)\b[^>]*>/gi)) {
    const attr = (name) => tag.match(new RegExp(`\\s${name}=["']?([^"'\\s>]+)`, "i"))?.[1];
    if (/^<link/i.test(tag) && !/^(?:stylesheet|preload|modulepreload|icon|apple-touch-icon|manifest)$/i.test(attr("rel") ?? "")) continue;
    for (const url of [attr("src"), attr("href"), ...(attr("srcset")?.split(",").map((s) => s.trim().split(/\s/)[0]) ?? [])]) {
      if (url && absolute.test(url)) offsite.push(`${relative(out, file)}: ${url}`);
    }
  }
}
for (const file of walk(out).filter((f) => f.endsWith(".css"))) {
  for (const [, url] of readFileSync(file, "utf8").matchAll(/url\(\s*["']?([^"')\s]+)/gi)) {
    if (absolute.test(url)) offsite.push(`${relative(out, file)}: ${url}`);
  }
}
for (const o of offsite) console.error(`static: loads from another site: ${o}`);
if (offsite.length) process.exit(1);

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
// The stubs that load a dynamic import's chunks (next/dynamic views, P3-03):
// a few hundred bytes each, and no page names them, so a page that used one
// offline would find it missing. They're precached with the shell.
for (const url of known) {
  if (!/^\/_next\/static\/chunks\/[^/]+\.js$/.test(url)) continue;
  const file = join(out, url);
  if (statSync(file).size < 2048 && /\.l\(/.test(readFileSync(file, "utf8"))) shell.add(url);
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
