// Tool pages carry their own content, as served before any script runs:
// enough words to answer the search, a description of their own, structured
// data that parses and matches what the page shows, and text that isn't the
// same page with another name.
//
//   npm run build:static
//   node tests/tool-content.mjs
//
// The visible text is what Chrome's innerText gives for the static HTML with
// its scripts removed and every request blocked: the server-rendered page.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pw from "playwright-core";
import { requireChrome } from "./lib/chrome.mjs";

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
const ok = (cond, what) => {
  if (!cond) throw new Error(what);
};

const tools = [...readFileSync(join(root, "src/lib/tools.ts"), "utf8").matchAll(/\bslug: "([a-z0-9-]+)"/g)].map((m) => m[1]);
const LANGS = ["en", "ar", "ja"];
const html = (lang, slug) => readFileSync(join(out, lang, `${slug}.html`), "utf8");
const decode = (s) => s.replaceAll("&quot;", '"').replaceAll("&#x27;", "'").replaceAll("&#39;", "'").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
const metaOf = (page, name) => {
  const tag = page.slice(0, page.indexOf("</head>")).match(new RegExp(`<meta\\b[^>]*name="${name}"[^>]*>`))?.[0];
  return tag ? decode(tag.match(/content="([^"]*)"/)?.[1] ?? "") : undefined;
};
const titleOf = (page) => decode(page.match(/<title>([^<]*)<\/title>/)?.[1] ?? "");
const jsonLd = (page) => [...page.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => m[1]);

// Visible text of every page, from Chrome.
const browser = await pw.chromium.launch({ executablePath: requireChrome() });
const context = await browser.newContext();
await context.route("**/*", (r) => r.abort());
const tab = await context.newPage();
const visible = {};
for (const lang of LANGS) {
  for (const slug of tools) {
    const page = html(lang, slug).replace(/<script\b[\s\S]*?<\/script>/g, "").replace(/<noscript\b[\s\S]*?<\/noscript>/g, "");
    await tab.setContent(page, { waitUntil: "domcontentloaded" });
    visible[`${lang}/${slug}`] = await tab.evaluate(() => document.body.innerText);
  }
}
await browser.close();
const words = (text) => text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w));

await test(`${tools.length} tools found`, () => ok(tools.length >= 31, `${tools.length} tools in src/lib/tools.ts`));

await test("every English tool page shows at least 350 words", () => {
  const counts = tools.map((s) => [s, words(visible[`en/${s}`]).length]);
  const thin = counts.filter(([, n]) => n < 350);
  if (process.env.VERBOSE) console.log(counts.map(([s, n]) => `${s} ${n}`).join(", "));
  const min = counts.reduce((a, b) => (b[1] < a[1] ? b : a));
  console.log(`      fewest: ${min[0]} with ${min[1]} words`);
  ok(!thin.length, `${thin.length} pages under 350 words: ${thin.slice(0, 5).map(([s, n]) => `${s} (${n})`).join(", ")}`);
});

await test("every English tool page has its own description of 120 to 160 characters", () => {
  const seen = new Map();
  const bad = [];
  for (const s of tools) {
    const d = metaOf(html("en", s), "description") ?? "";
    if (d.length < 120 || d.length > 160) bad.push(`${s}: ${d.length} characters`);
    if (seen.has(d)) bad.push(`${s} repeats ${seen.get(d)}`);
    seen.set(d, s);
    // Social cards say the same.
    const og = html("en", s).match(/<meta\b[^>]*property="og:description"[^>]*content="([^"]*)"/)?.[1];
    if (decode(og ?? "") !== d) bad.push(`${s}: og:description differs`);
  }
  ok(!bad.length, bad.slice(0, 5).join("; "));
});

await test("every English tool page has its own title", () => {
  const titles = tools.map((s) => titleOf(html("en", s)));
  const dup = titles.filter((t, i) => titles.indexOf(t) !== i);
  ok(!dup.length, `repeated titles: ${dup.join(", ")}`);
  const long = titles.filter((t) => t.length > 65);
  ok(!long.length, `titles over 65 characters: ${long.join(", ")}`);
});

await test("JSON-LD parses and describes the tool, its steps, its questions and its place", () => {
  const bad = [];
  for (const lang of LANGS) {
    for (const s of tools) {
      const blocks = jsonLd(html(lang, s));
      if (!blocks.length) {
        bad.push(`${lang}/${s}: no JSON-LD`);
        continue;
      }
      let data;
      try {
        data = blocks.map((b) => JSON.parse(b));
      } catch (e) {
        bad.push(`${lang}/${s}: ${e.message}`);
        continue;
      }
      const nodes = data.flatMap((d) => d["@graph"] ?? [d]);
      const of = (type) => nodes.find((n) => [n["@type"]].flat().includes(type));
      const app = of("SoftwareApplication");
      const howTo = of("HowTo");
      const faq = of("FAQPage");
      const crumbs = of("BreadcrumbList");
      if (!app || !howTo || !faq || !crumbs) {
        bad.push(`${lang}/${s}: types ${nodes.map((n) => n["@type"]).join(", ")}`);
        continue;
      }
      const offer = [app.offers].flat()[0];
      if (!offer || Number(offer.price) !== 0 || !offer.priceCurrency) bad.push(`${lang}/${s}: offer ${JSON.stringify(app.offers)}`);
      if (!/^https:\/\//.test(app.url ?? "") || !app.url.endsWith(`/${lang}/${s}`)) bad.push(`${lang}/${s}: url ${app.url}`);
      if (app.inLanguage !== lang) bad.push(`${lang}/${s}: inLanguage ${app.inLanguage}`);
      if ((howTo.step ?? []).length < 3) bad.push(`${lang}/${s}: ${howTo.step?.length} steps`);
      const items = crumbs.itemListElement ?? [];
      if (items.length < 2 || !items.at(-1).item?.endsWith(`/${lang}/${s}`)) bad.push(`${lang}/${s}: breadcrumb ${JSON.stringify(items)}`);
      // Marked-up questions and answers must be on the page for people too.
      const text = visible[`${lang}/${s}`].replace(/\s+/g, " ");
      const qa = faq.mainEntity ?? [];
      if (qa.length < 4 || qa.length > 6) bad.push(`${lang}/${s}: ${qa.length} questions`);
      for (const q of qa) {
        if (!text.includes(q.name.replace(/\s+/g, " "))) bad.push(`${lang}/${s}: question not shown: ${q.name}`);
        if (!text.includes(q.acceptedAnswer?.text?.replace(/\s+/g, " "))) bad.push(`${lang}/${s}: answer not shown: ${q.name}`);
      }
      for (const step of howTo.step ?? []) if (!text.includes(step.text.replace(/\s+/g, " "))) bad.push(`${lang}/${s}: step not shown: ${step.text}`);
    }
  }
  ok(!bad.length, `${bad.length} problems, e.g. ${bad.slice(0, 4).join("; ")}`);
});

// Shared text: the share of one page's five-word sequences that the other
// page also has, against the smaller page. Header, footer and the workspace
// are shared by design; the rest must be each tool's own.
const shingles = (text) => {
  const w = words(text.toLowerCase());
  const set = new Set();
  for (let i = 0; i + 5 <= w.length; i++) set.add(w.slice(i, i + 5).join(" "));
  return set;
};
await test("no two English tool pages share half their text", () => {
  const sets = tools.map((s) => [s, shingles(visible[`en/${s}`])]);
  let worst = { score: 0 };
  const over = [];
  for (let i = 0; i < sets.length; i++)
    for (let j = i + 1; j < sets.length; j++) {
      const [a, A] = sets[i];
      const [b, B] = sets[j];
      let shared = 0;
      for (const x of A) if (B.has(x)) shared++;
      const score = shared / Math.min(A.size, B.size);
      if (score > worst.score) worst = { score, pair: `${a} / ${b}` };
      if (score >= 0.5) over.push(`${a} / ${b} ${(score * 100).toFixed(0)}%`);
    }
  console.log(`      most similar: ${worst.pair} at ${(worst.score * 100).toFixed(1)}%`);
  ok(!over.length, `${over.length} pairs at 50% or more, e.g. ${over.slice(0, 4).join(", ")}`);
});

// Every page sends the dictionary to the browser; the long-form content is
// for the server-rendered HTML only, so it must not ride along on every page.
await test("tool-page content stays out of the dictionary the browser gets", () => {
  const leaks = ["en.html", "en/merge-pdf.html", "en/faq.html"].filter((f) => /\\?"(tool\.merge\.intro|tp\.howTo)\\?"/.test(readFileSync(join(out, f), "utf8")));
  ok(!leaks.length, `content keys in the client payload of ${leaks.join(", ")}`);
});

process.exit(results.failed ? 1 : 0);
