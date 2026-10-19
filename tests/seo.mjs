// Search and sharing checks on the static build: every page names itself as
// canonical and lists its translations with absolute URLs, the sitemap and
// robots.txt exist, pages have social cards, the icons browsers and app
// stores ask for are there, and error pages stay out of search results.
// Tools and search-intent pages have localized addresses (/es/unir-pdf), and
// the old English ones (/es/merge-pdf) redirect to them.
//
//   npm run build:static
//   node tests/seo.mjs
//
// Checks against NEXT_PUBLIC_SITE_URL when it is set, as for the build. The
// last check starts a release build without it, which must stop at once (it
// runs the server build, so out/ is left alone even if it doesn't stop).
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { register } from "node:module";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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
// Old addresses left behind as redirect pages, for hosts without _redirects.
const isRedirect = (file) => /<meta\s+http-equiv="refresh"/i.test(read(file));
const urlPath = (file) => (file === "index.html" ? "/" : `/${file.replace(/\.html$/, "")}`);
const isError = (file) => /(^|\/)(404|_not-found)\.html$/.test(file);
const redirects = pages.filter((f) => !isError(f) && isRedirect(f));
const indexable = pages.filter((f) => !isError(f) && !redirects.includes(f));

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

// The slug tables and intent pages, read from the source: Node strips the
// types, and a hook adds the ".ts" that bundlers let imports leave out.
const hook = String.raw`export const resolve = (s, c, next) => next(/^\.\.?\//.test(s) && !/\.\w+$/.test(s) ? s + ".ts" : s, c);`;
register(`data:text/javascript,${encodeURIComponent(hook)}`);
const { SLUGS, localSlug } = await import(pathToFileURL(join(root, "src/lib/i18n/slugs.ts")).href);
const { INTENTS } = await import(pathToFileURL(join(root, "src/lib/intents.ts")).href);
const intents = INTENTS.map((i) => i.slug);
const slugOf = Object.fromEntries([...readFileSync(join(root, "src/lib/tools.ts"), "utf8").matchAll(/\bid: "(\w+)", slug: "([a-z0-9-]+)"/g)].map((m) => [m[1], m[2]]));
// Every page there was before slugs were localized, now elsewhere.
const moved = locales.flatMap((l) => tools.filter((s) => localSlug(s, l) !== s).map((s) => ({ from: `/${l}/${s}`, to: `/${l}/${localSlug(s, l)}` })));

await test(`the site has an absolute https address (${origin || "none"})`, () => {
  ok(/^https:\/\/[^/]+$/.test(origin), "no absolute canonical on /en");
  eq(locales.length, 26, "languages found in out/");
  eq(tools.length >= 31, true, "tools found in src/lib/tools.ts");
});

await test("es/unir-pdf: one canonical, itself", () => {
  const { canonical } = head("es/unir-pdf.html");
  eq(canonical.length, 1, "canonical links");
  eq(canonical[0], abs("/es/unir-pdf"), "canonical");
});

await test("es/unir-pdf: 27 absolute alternates in each language's words, x-default included", () => {
  const { alternates } = head("es/unir-pdf.html");
  eq(alternates.length, 27, "hreflang links");
  const map = Object.fromEntries(alternates);
  for (const l of locales) eq(map[l], abs(`/${l}/${localSlug("merge-pdf", l)}`), `hreflang ${l}`);
  eq(map.de, abs("/de/pdf-zusammenfuegen"), "hreflang de");
  eq(map.ja, abs("/ja/merge-pdf"), "hreflang ja");
  eq(map["x-default"], abs("/en/merge-pdf"), "x-default");
});

await test("slugs: ASCII, unique in each language, never an English slug of another page", () => {
  const fixed = ["workflows", "404", "account", "contact", "login", "register", "features", "faq", "security", "about", "guide", "privacy", "terms", "cookies", "licenses"];
  const bad = [];
  const english = [...tools, ...intents];
  for (const l of locales) {
    const own = english.map((s) => localSlug(s, l));
    const seen = new Map();
    for (const [i, s] of own.entries()) {
      if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(s)) bad.push(`${l}/${s} isn't a plain slug`);
      if (seen.has(s)) bad.push(`${l}/${s} is both ${seen.get(s)} and ${english[i]}`);
      seen.set(s, english[i]);
      if (fixed.includes(s)) bad.push(`${l}/${s} hides a fixed page`);
      // An old address that redirects must not be another page's new one.
      if (english.includes(s) && s !== english[i]) bad.push(`${l}/${s} is ${english[i]} here but ${s} in English`);
    }
    const table = SLUGS[l];
    if (table) for (const s of english) if (!(s in table) && !["ocr-pdf", "edit-pdf", "pdf-converter", "pdf-editor"].includes(s)) bad.push(`${l} has no slug for ${s}`);
    if (table) for (const k of Object.keys(table)) if (!english.includes(k)) bad.push(`${l} names an unknown page ${k}`);
  }
  ok(!bad.length, `${bad.length} problems, e.g. ${bad.slice(0, 4).join("; ")}`);
  ok(Object.keys(SLUGS).length >= 18, `only ${Object.keys(SLUGS).length} languages have their own slugs`);
});

await test("every tool and intent page exists in every language, at its localized address", () => {
  const missing = locales.flatMap((l) => [...tools, ...intents].map((s) => `${l}/${localSlug(s, l)}.html`)).filter((f) => !indexable.includes(f));
  ok(!missing.length, `${missing.length} missing, e.g. ${missing.slice(0, 4).join(", ")}`);
  eq(moved.length > 18 * 25, true, `${moved.length} moved pages`);
});

await test("hreflang is reciprocal: every translation lists the same set back", () => {
  const bad = [];
  const sets = new Map(indexable.map((f) => [f, JSON.stringify(head(f).alternates.sort())]));
  for (const file of indexable) {
    const { alternates } = head(file);
    for (const [lang, href] of alternates) {
      const path = new URL(href).pathname;
      const other = path === "/" ? "index.html" : `${path.slice(1)}.html`;
      if (!sets.has(other)) bad.push(`${file} ${lang} → ${href}, not a page`);
      else if (sets.get(other) !== sets.get(file)) bad.push(`${file} and ${other} disagree`);
    }
  }
  ok(!bad.length, `${bad.length} problems, e.g. ${bad.slice(0, 3).join("; ")}`);
});

await test("every old English address redirects: _redirects 301 and a refresh page", () => {
  ok(existsSync(join(out, "_redirects")), "no out/_redirects");
  const rules = read("_redirects").split("\n").filter((l) => l.trim() && !l.startsWith("#")).map((l) => l.trim().split(/\s+/));
  ok(rules.length <= 2000, `${rules.length} rules; Cloudflare Pages takes 2,000 static ones`);
  const byFrom = new Map(rules.map((r) => [r[0], r]));
  const bad = [];
  for (const { from, to } of moved) {
    const rule = byFrom.get(from);
    if (!rule || rule[1] !== to || rule[2] !== "301") bad.push(`_redirects ${from}: ${rule?.join(" ") ?? "none"}`);
    const file = `${from.slice(1)}.html`;
    if (!redirects.includes(file)) { bad.push(`no refresh page ${file}`); continue; }
    const html = read(file);
    const refresh = html.match(/<meta\s+http-equiv="refresh"\s+content="0;\s*url=([^"]+)"/i)?.[1];
    if (refresh !== to) bad.push(`${file} refreshes to ${refresh}`);
    if (!same(head(file).canonical[0], abs(to))) bad.push(`${file} canonical ${head(file).canonical[0]}`);
  }
  for (const [from, to] of byFrom) if (!moved.some((m) => m.from === from && m.to === to[1])) bad.push(`unexpected rule ${from}`);
  ok(!bad.length, `${bad.length} problems, e.g. ${bad.slice(0, 3).join("; ")}`);
});

await test("pages link to localized addresses, never to a redirect", () => {
  const old = new Set(moved.map((m) => m.from));
  const bad = [];
  for (const file of indexable) {
    for (const [, href] of read(file).matchAll(/<a\b[^>]*\shref="([^"#?]+)/g)) if (old.has(href)) bad.push(`${file} → ${href}`);
  }
  ok(!bad.length, `${bad.length} links to old addresses, e.g. ${bad.slice(0, 3).join("; ")}`);
});

await test("intent pages: own title, every tool linked at its localized address", () => {
  const bad = [];
  for (const l of locales)
    for (const intent of INTENTS) {
      const file = `${l}/${localSlug(intent.slug, l)}.html`;
      const html = read(file);
      const h1 = html.match(/<h1\b[^>]*>([^<]*)<\/h1>/)?.[1].replaceAll("&#x27;", "'");
      if (h1 !== intent.title[l]) bad.push(`${file} h1 ${h1}`);
      for (const id of intent.tools)
        if (!html.includes(`href="/${l}/${localSlug(slugOf[id], l)}"`)) bad.push(`${file} doesn't link ${id}`);
    }
  ok(!bad.length, `${bad.length} problems, e.g. ${bad.slice(0, 3).join("; ")}`);
});

await test("every page: canonical is itself, translations of the same page", () => {
  const bad = [];
  for (const file of indexable) {
    const path = urlPath(file);
    const { canonical, alternates } = head(file);
    if (canonical.length !== 1 || !same(canonical[0], abs(path))) bad.push(`${file} canonical ${canonical.join(" ")}`);
    if (alternates.length !== locales.length + 1) bad.push(`${file} has ${alternates.length} alternates`);
    // Itself among them, and x-default is the English page (/ for the home cluster).
    const map = Object.fromEntries(alternates);
    const lang = path === "/" ? null : path.split("/")[1];
    if (lang && !same(map[lang], abs(path))) bad.push(`${file} ${lang} → ${map[lang]}`);
    const home = path === "/" || path.split("/").length === 2;
    if (!same(map["x-default"], home ? abs("/") : map.en)) bad.push(`${file} x-default → ${map["x-default"]}`);
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
  const extra = urls.filter((u) => new URL(u.loc).origin !== origin || !indexable.includes(fileFor(u.loc)));
  ok(!extra.length, `sitemap URLs with no page or only a redirect: ${extra.slice(0, 3).map((u) => u.loc).join(", ")}`);
  const notCanonical = urls.filter((u) => !same(head(fileFor(u.loc)).canonical[0], u.loc));
  ok(!notCanonical.length, `sitemap URLs that aren't canonical: ${notCanonical.slice(0, 3).map((u) => u.loc).join(", ")}`);
  const thin = urls.filter((u) => u.links !== locales.length + 1);
  ok(!thin.length, `${thin.length} URLs without ${locales.length + 1} alternates, e.g. ${thin[0]?.loc}`);
});

// The server build answers "/" with a redirect to a language, so its sitemap
// leaves "/" out; only the static build has a page there. src/lib/seo.ts
// runs here directly: Node strips the types, and a hook adds the ".ts" that
// bundlers let imports leave out.
const sitemapOf = (build) => {
  const code = `import { register } from "node:module";
register("data:text/javascript,${encodeURIComponent(hook)}");
const { sitemapXml } = await import(${JSON.stringify(pathToFileURL(join(root, "src/lib/seo.ts")).href)});
process.stdout.write(sitemapXml());`;
  const env = { ...process.env, NEXT_PUBLIC_STATIC: build === "static" ? "1" : "" };
  const run = spawnSync(process.execPath, ["--no-warnings", "--input-type=module", "-e", code], { env, encoding: "utf8", maxBuffer: 1 << 26 });
  ok(run.status === 0, `src/lib/seo.ts didn't run: ${run.stderr.slice(-300)}`);
  return run.stdout;
};

await test("the server build's sitemap lists no redirect", () => {
  const locs = (xml) => [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => new URL(m[1]).pathname);
  const server = sitemapOf("server");
  ok(locs(server).length >= 1040, `${locs(server).length} URLs`);
  ok(!locs(server).includes("/"), "lists /, which the server redirects");
  ok(/hreflang="x-default" href="https:\/\/[^/"]+\/"/.test(server), "home pages lost their x-default");
  ok(locs(sitemapOf("static")).includes("/"), "the static sitemap lost /");
});

await test("out/ stays under Cloudflare Pages' file limit", () => {
  const count = readdirSync(out, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).length;
  ok(count < 18000, `${count} files; keep it under 18,000`);
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
      const local = localSlug(slug, lang);
      const { meta } = head(`${lang}/${local}.html`);
      if (meta("og:image")[0] !== abs(`/og/${slug}.png`)) bad.push(`${lang}/${local} og:image ${meta("og:image")[0]}`);
      if (meta("twitter:card")[0] !== "summary_large_image") bad.push(`${lang}/${local} twitter:card`);
      if (!meta("og:title")[0] || meta("og:url")[0] !== abs(`/${lang}/${local}`)) bad.push(`${lang}/${local} og:title/url`);
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
  const env = { ...process.env, NOPLOAD_RELEASE: "1", NOPLOAD_STATIC: "", NEXT_PUBLIC_SITE_URL: "" };
  const run = spawnSync(join(root, "node_modules/.bin/next"), ["build"], { cwd: root, env, encoding: "utf8", timeout: 300000 });
  ok(run.status !== 0, "the release build finished with placeholders");
  ok(/NEXT_PUBLIC_SITE_URL is not set/.test(run.stdout + run.stderr), `unexpected failure: ${(run.stdout + run.stderr).slice(-300)}`);
});

process.exit(results.failed ? 1 : 0);
