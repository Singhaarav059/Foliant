// Search and sharing checks on the static build: every page names itself as
// canonical and lists its translations with absolute URLs, the sitemap and
// robots.txt exist, pages have social cards, the icons browsers and app
// stores ask for are there, and error pages stay out of search results.
//
//   npm run build:static
//   node tests/seo.mjs
//
// Checks against NEXT_PUBLIC_SITE_URL when it is set, as for the build. The
// last check starts a release build without it, which must stop at once (it
// runs the server build, so out/ is left alone even if it doesn't stop).
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "out");
const results = { failed: 0 };
const test = async (name, fn) => {
  try {
    await fn();
    console.log(`ok    ${name}`);
  } catch (e) {
    results.failed++;
    console.log(`FAIL  ${name}: ${e.message}`);
  }
};
const eq = (a, b, what) => {
  if (a !== b) throw new Error(`${what}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
};
const ok = (cond, what) => {
  if (!cond) throw new Error(what);
};

const read = (path) => readFileSync(join(out, path), "utf8");
const attr = (tag, name) => tag.match(new RegExp(`\\s${name}="([^"]*)"`, "i"))?.[1].replaceAll("&amp;", "&");
// The <head> tags of a page, by kind.
function head(path) {
  const html = read(path);
  const tags = html.slice(0, html.indexOf("</head>")).match(/<(?:link|meta)\b[^>]*>/g) ?? [];
  const links = (rel) => tags.filter((t) => attr(t, "rel") === rel);
  const meta = (key) => tags.filter((t) => attr(t, "property") === key || attr(t, "name") === key).map((t) => attr(t, "content"));
  return {
    canonical: links("canonical").map((t) => attr(t, "href")),
    alternates: links("alternate").filter((t) => attr(t, "hreflang")).map((t) => [attr(t, "hreflang"), attr(t, "href")]),
    icons: [...links("icon"), ...links("apple-touch-icon")].map((t) => attr(t, "href")),
    meta,
  };
}
const png = (path) => {
  const b = readFileSync(join(out, path));
  ok(b.subarray(1, 4).toString() === "PNG", `${path} is not a PNG`);
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
};

// Every HTML page, as its URL path: es/merge-pdf.html → /es/merge-pdf.
const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  const p = join(dir, e.name);
  if (e.isDirectory()) return e.name === "_next" || e.name === "vendor" ? [] : walk(p);
  return e.name.endsWith(".html") ? [relative(out, p)] : [];
});
const pages = walk(out);
const urlPath = (file) => (file === "index.html" ? "/" : `/${file.replace(/\.html$/, "")}`);
const isError = (file) => /(^|\/)(404|_not-found)\.html$/.test(file);
const indexable = pages.filter((f) => !isError(f));

// The site's address: the configured one, else whatever the home page claims,
// which must at least be absolute.
const home = head("en.html").canonical[0] ?? "";
const origin = (process.env.NEXT_PUBLIC_SITE_URL || (/^https?:\/\//.test(home) ? new URL(home).origin : "")).replace(/\/+$/, "");
const abs = (path) => (path === "/" ? `${origin}/` : `${origin}${path}`);
const same = (a, b) => {
  try {
    return new URL(a).href === new URL(b).href;
  } catch {
    return false;
  }
};
const locales = readdirSync(out).filter((f) => f.endsWith(".html") && existsSync(join(out, f.replace(/\.html$/, ""), "404.html"))).map((f) => f.replace(/\.html$/, ""));
const tools = [...readFileSync(join(root, "src/lib/tools.ts"), "utf8").matchAll(/\bslug: "([a-z0-9-]+)"/g)].map((m) => m[1]);

await test(`the site has an absolute https address (${origin || "none"})`, () => {
  ok(/^https:\/\/[^/]+$/.test(origin), "no absolute canonical on /en");
  eq(locales.length, 26, "languages found in out/");
  eq(tools.length >= 31, true, "tools found in src/lib/tools.ts");
});

await test("es/merge-pdf: one canonical, itself", () => {
  const { canonical } = head("es/merge-pdf.html");
  eq(canonical.length, 1, "canonical links");
  eq(canonical[0], abs("/es/merge-pdf"), "canonical");
});

await test("es/merge-pdf: 27 absolute alternates, itself and x-default included", () => {
  const { alternates } = head("es/merge-pdf.html");
  eq(alternates.length, 27, "hreflang links");
  const map = Object.fromEntries(alternates);
  for (const l of locales) eq(map[l], abs(`/${l}/merge-pdf`), `hreflang ${l}`);
  eq(map["x-default"], abs("/en/merge-pdf"), "x-default");
});

await test("every page: canonical is itself, translations of the same page", () => {
  const bad = [];
  for (const file of indexable) {
    const path = urlPath(file);
    const { canonical, alternates } = head(file);
    if (canonical.length !== 1 || !same(canonical[0], abs(path))) bad.push(`${file} canonical ${canonical.join(" ")}`);
    if (alternates.length !== locales.length + 1) bad.push(`${file} has ${alternates.length} alternates`);
    // Same page in each language: /xx/rest or, for the home cluster, /xx and /.
    const rest = path === "/" ? "" : path.replace(/^\/[^/]+/, "");
    for (const [lang, href] of alternates) {
      const want = lang === "x-default" ? (rest ? abs(`/en${rest}`) : abs("/")) : abs(`/${lang}${rest}`);
      if (!same(href, want)) bad.push(`${file} ${lang} → ${href}`);
    }
  }
  ok(!bad.length, `${bad.length} problems, e.g. ${bad.slice(0, 3).join("; ")}`);
});

await test("/ is the indexable x-default home, error pages are noindex", () => {
  ok(!head("index.html").meta("robots").some((r) => /noindex/.test(r)), "/ is noindex");
  eq(head("index.html").alternates.length, 27, "alternates on /");
  const open = pages.filter(isError).filter((f) => !head(f).meta("robots").some((r) => /noindex/.test(r)));
  ok(pages.filter(isError).length >= 27, "error pages missing");
  ok(!open.length, `indexable error pages: ${open.slice(0, 4).join(", ")}`);
});

await test("sitemap.xml lists every page with its translations", () => {
  ok(existsSync(join(out, "sitemap.xml")), "no out/sitemap.xml");
  const xml = read("sitemap.xml");
  ok(xml.includes('xmlns:xhtml="http://www.w3.org/1999/xhtml"'), "no xhtml namespace");
  const urls = [...xml.matchAll(/<url>([\s\S]*?)<\/url>/g)].map((m) => ({
    loc: m[1].match(/<loc>([^<]+)<\/loc>/)?.[1],
    links: [...m[1].matchAll(/<xhtml:link\b[^>]*>/g)].length,
  }));
  ok(urls.length >= 1040, `${urls.length} URLs, want at least 1040`);
  const listed = new Set(urls.map((u) => new URL(u.loc).href));
  const missing = indexable.filter((f) => !listed.has(new URL(abs(urlPath(f))).href));
  ok(!missing.length, `pages missing from the sitemap: ${missing.slice(0, 4).join(", ")}`);
  const fileFor = (loc) => (new URL(loc).pathname === "/" ? "index" : new URL(loc).pathname.slice(1)) + ".html";
  const extra = urls.filter((u) => new URL(u.loc).origin !== origin || !pages.includes(fileFor(u.loc)));
  ok(!extra.length, `sitemap URLs with no page: ${extra.slice(0, 3).map((u) => u.loc).join(", ")}`);
  const thin = urls.filter((u) => u.links !== locales.length + 1);
  ok(!thin.length, `${thin.length} URLs without ${locales.length + 1} alternates, e.g. ${thin[0]?.loc}`);
});

await test("robots.txt allows crawling and names the sitemap", () => {
  ok(existsSync(join(out, "robots.txt")), "no out/robots.txt");
  const txt = read("robots.txt");
  ok(txt.split("\n").some((l) => l.trim() === `Sitemap: ${origin}/sitemap.xml`), "no Sitemap: line");
  ok(!/^Disallow:\s*\/\s*$/m.test(txt), "disallows everything");
});

await test("every tool page has its own social card, in every language", () => {
  const bad = [];
  for (const lang of locales)
    for (const slug of tools) {
      const { meta } = head(`${lang}/${slug}.html`);
      if (meta("og:image")[0] !== abs(`/og/${slug}.png`)) bad.push(`${lang}/${slug} og:image ${meta("og:image")[0]}`);
      if (meta("twitter:card")[0] !== "summary_large_image") bad.push(`${lang}/${slug} twitter:card`);
      if (!meta("og:title")[0] || meta("og:url")[0] !== abs(`/${lang}/${slug}`)) bad.push(`${lang}/${slug} og:title/url`);
    }
  ok(!bad.length, `${bad.length} problems, e.g. ${bad.slice(0, 3).join("; ")}`);
  for (const slug of tools) {
    const { width, height } = png(`og/${slug}.png`);
    eq(`${width}x${height}`, "1200x630", `og/${slug}.png size`);
  }
});

await test("every other page has a social card that exists", () => {
  const bad = indexable.filter((f) => {
    const img = head(f).meta("og:image")[0];
    return !img?.startsWith(`${origin}/`) || !existsSync(join(out, new URL(img).pathname));
  });
  ok(!bad.length, `${bad.length} pages without a working og:image, e.g. ${bad.slice(0, 3).join(", ")}`);
});

await test("favicon.ico, PNG icons and the manifest", () => {
  ok(existsSync(join(out, "favicon.ico")), "no out/favicon.ico");
  const ico = readFileSync(join(out, "favicon.ico"));
  eq(ico.readUInt32LE(0), 0x10000, "ICO header");
  ok(ico.readUInt16LE(4) >= 1, "ICO has no images");
  for (const [file, size] of [["icon-192.png", 192], ["icon-512.png", 512], ["icon-maskable-512.png", 512], ["apple-touch-icon.png", 180]]) {
    const { width, height } = png(file);
    eq(`${width}x${height}`, `${size}x${size}`, file);
  }
  const manifest = JSON.parse(read("manifest.webmanifest"));
  const icons = manifest.icons.map((i) => `${i.src} ${i.sizes} ${i.purpose ?? "any"}`);
  for (const want of ["/icon-192.png 192x192 any", "/icon-512.png 512x512 any", "/icon-maskable-512.png 512x512 maskable"])
    ok(icons.includes(want), `manifest icon missing: ${want}`);
  ok(!("file_handlers" in manifest), "manifest declares file_handlers nothing handles");
  const linked = head("en/merge-pdf.html").icons;
  for (const want of ["/favicon.ico", "/apple-touch-icon.png"]) ok(linked.some((h) => h.endsWith(want)), `pages don't link ${want}`);
});

await test("a release build without NEXT_PUBLIC_SITE_URL stops", () => {
  const env = { ...process.env, FOLIANT_RELEASE: "1", FOLIANT_STATIC: "", NEXT_PUBLIC_SITE_URL: "" };
  const run = spawnSync(join(root, "node_modules/.bin/next"), ["build"], { cwd: root, env, encoding: "utf8", timeout: 300000 });
  ok(run.status !== 0, "the release build finished with placeholders");
  ok(/NEXT_PUBLIC_SITE_URL is not set/.test(run.stdout + run.stderr), `unexpected failure: ${(run.stdout + run.stderr).slice(-300)}`);
});

process.exit(results.failed ? 1 : 0);
