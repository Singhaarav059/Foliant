// Smoke test of every tool in a real browser, in several languages.
//
//   npm run build:static
//   node scripts/serve-static.mjs out 3202 &
//   node tests/e2e/tools/run.mjs [--lang en,ar,ja] [--only <slug regex>] [--browser chromium]
//
// Each tool slug in src/lib/tools.ts has a spec here named <slug>.mjs. A spec
// runs the tool once with its default options and once with one option
// changed, then checks the file that comes back (type, page count, text) with
// pdf-lib, pdf.js and JSZip. A slug without a spec fails. Any request that
// leaves the site's origin is blocked and fails the case that made it.
//
// known-failures.json lists cases that fail because of a product bug, with
// the reason. They print as KNOWN and don't fail the run; a listed case that
// passes does fail, so the list can't go stale.
//
// BASE_URL and CHROME_PATH work as in tests/e2e.mjs.
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { base, fixtures, launch, open, root } from "../kit.mjs";
import { helpers, inspect, makeFixtures, outcome } from "./lib.mjs";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const langs = arg("lang", "en,ar,ja").split(",");
const only = arg("only") ? new RegExp(arg("only")) : null;
const engine = arg("browser", "chromium");

const here = join(root, "tests/e2e/tools");
const slugs = [...readFileSync(join(root, "src/lib/tools.ts"), "utf8").matchAll(/\bslug: "([^"]+)"/g)].map((m) => m[1]).filter((s) => !only || only.test(s));
const specFiles = new Set(readdirSync(here).filter((f) => f.endsWith(".mjs")).map((f) => f.slice(0, -4)));
const specs = {};
for (const slug of slugs) if (specFiles.has(slug)) specs[slug] = (await import(pathToFileURL(join(here, `${slug}.mjs`)).href)).default;
// A spec that needs another's output (unlock needs protect's file) runs after it.
for (const slug of [...slugs]) {
  const after = slugs.indexOf(specs[slug]?.after);
  if (after > slugs.indexOf(slug)) slugs.splice(after, 0, ...slugs.splice(slugs.indexOf(slug), 1));
}
const known = JSON.parse(readFileSync(join(here, "known-failures.json"), "utf8"));
const knownFor = (lang, slug, variant) => known.find((k) => k.slug === slug && k.variant === variant && (!k.langs || k.langs.includes(lang)));

const tmp = mkdtempSync(join(tmpdir(), "e2e-tools-"));
const fxDir = join(tmp, "fixtures");
const fx = (n) => (n.startsWith("/") ? n : [ "photo.jpg", "logo.png", "form.pdf", "truncated.pdf", "page.html", "with-blank.pdf", "photo-page.pdf" ].includes(n) ? join(fxDir, n) : join(fixtures, n));

const browser = await launch(engine);
await makeFixtures(browser, fxDir);
const results = [];
const state = {}; // files one spec leaves for a later one (protect → unlock)

for (const lang of langs) {
  const ctx = await browser.newContext({ acceptDownloads: true, locale: lang, viewport: { width: 1440, height: 900 } });
  let foreign = [];
  await ctx.route((u) => u.origin !== new URL(base).origin && !/^(blob|data):$/.test(u.protocol), (r) => {
    foreign.push(new URL(r.request().url()).host);
    return r.abort();
  });
  // A returning visitor: the service worker is installed before the tools run.
  {
    const p = await ctx.newPage();
    await open(p, `/${lang}`);
    await p.evaluate(() => Promise.race([navigator.serviceWorker?.ready, new Promise((r) => setTimeout(r, 10000))]));
    await p.close();
  }

  for (const slug of slugs) {
    const spec = specs[slug];
    if (!spec) {
      results.push({ lang, slug, variant: "-", ok: false, detail: `no spec: add tests/e2e/tools/${slug}.mjs` });
      continue;
    }
    for (const [variant, v] of Object.entries(spec.variants)) {
      const t0 = Date.now();
      const rec = { lang, slug, variant, ok: false, detail: "" };
      foreign = [];
      const page = await ctx.newPage();
      const downloads = [];
      const errors = [];
      page.on("download", (d) => downloads.push(d));
      page.on("pageerror", (e) => errors.push(e.message.split("\n")[0].slice(0, 120)));
      const h = helpers(page, fx);
      h.state = state;
      h.lang = lang;
      try {
        await open(page, `/${lang}/${slug}`);
        const files = (v.files ?? spec.files).map((f) => (f.startsWith("@") ? state[f.slice(1)] : f));
        if (files.some((f) => !f)) throw new Error("missing input from an earlier spec");
        await h.pick(files);
        let r;
        if (v.run ?? spec.run) {
          r = await (v.run ?? spec.run)(h);
        } else {
          await page.waitForSelector("main aside.card", { timeout: 30000 });
          if (spec.prepare) await spec.prepare(h, variant);
          if (v.set) await v.set(h);
          await h.action().click({ timeout: 10000 });
          // Office files ask once before LibreOffice downloads: agree.
          page.locator("section[aria-labelledby=office-consent] button.btn-primary").click({ timeout: 30000 }).catch(() => {});
          const res = await outcome(page, v.timeout ?? spec.timeout ?? 90000);
          if (res.kind === "error") r = res;
          else if (res.kind === "print") {
            const frame = page.frameLocator("main iframe[sandbox]");
            await frame.locator("body").waitFor({ timeout: 15000 });
            await page.waitForFunction(() => (document.querySelector("main iframe[sandbox]")?.contentDocument?.body?.innerText ?? "x").length > 10, null, { timeout: 15000 }).catch(() => {});
            r = { kind: "print", text: (await frame.locator("body").innerText()).replace(/\s+/g, " "), scriptRan: (await frame.locator("#ran").count()) > 0 };
          } else {
            // A single result downloads by itself; else press the (zip) download button.
            const until = Date.now() + 5000;
            while (!downloads.length && Date.now() < until) await page.waitForTimeout(100);
            if (!downloads.length) {
              const [d] = await Promise.all([
                page.waitForEvent("download", { timeout: 30000 }),
                (res.kind === "multi" ? h.icon("file-archive") : page.locator("main button.btn-primary").first()).click(),
              ]);
              if (!downloads.includes(d)) downloads.push(d);
            }
            const d = downloads.at(-1);
            const path = join(tmp, `${lang}-${slug}-${variant.replace(/\W+/g, "_")}-${d.suggestedFilename()}`);
            await d.saveAs(path);
            r = { ...(await inspect(path)), kind: res.kind, path };
          }
        }
        if (v.keep) state[v.keep] = r.path;
        const said = await v.check(r, h);
        if (foreign.length) throw new Error(`requests left the origin: ${[...new Set(foreign)].join(", ")}`);
        rec.ok = true;
        rec.detail = said ?? summary(r);
      } catch (e) {
        rec.detail = e.message.split("\n")[0].slice(0, 220) + (errors.length ? ` [page error: ${errors[0]}]` : "");
      }
      rec.ms = Date.now() - t0;
      const k = knownFor(lang, slug, variant);
      if (k) {
        rec.known = k.reason;
        if (rec.ok) { rec.ok = false; rec.detail = `listed in known-failures.json but passes now; remove it (${k.reason})`; }
      }
      results.push(rec);
      console.log(line(rec));
      await page.close();
    }
  }
  await ctx.close();
}
await browser.close();

function summary(r) {
  if (!r || typeof r !== "object") return "";
  const bits = [r.kind, r.type, r.pages && `${r.pages}p`, r.entries && `${r.entries.length} files`, r.slides && `${r.slides} slides`, r.sheets && `${r.sheets} sheets`];
  return bits.filter(Boolean).join(" ");
}
function line(r) {
  const tag = r.ok ? "PASS" : r.known ? "KNOWN" : "FAIL";
  return `${tag.padEnd(5)} ${r.lang.padEnd(3)} ${r.slug.padEnd(18)} ${r.variant.padEnd(22)} ${`${r.ms ?? 0}ms`.padStart(8)}  ${r.known && !r.ok ? `${r.detail} — known: ${r.known}` : r.detail}`;
}

console.log("\nReport");
for (const r of results) console.log(line(r));
const failed = results.filter((r) => !r.ok && !r.known);
const knownCount = results.filter((r) => !r.ok && r.known).length;
console.log(`\n${results.length - failed.length - knownCount}/${results.length} passed, ${knownCount} known failures, ${failed.length} failed (${langs.join(", ")})`);
process.exit(failed.length ? 1 : 0);
