// The static build's finishing step (scripts/static-extras.mjs) on small
// stand-in builds: it writes the host files, redirects old addresses to the
// localized ones the sitemap lists, and it refuses a build that Cloudflare
// Pages' free plan wouldn't take.
//
//   node tests/static-extras.mjs
import { spawnSync } from "node:child_process";
import { closeSync, copyFileSync, existsSync, ftruncateSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
let failed = 0;
const test = async (name, fn) => {
  try {
    await fn();
    console.log(`ok    ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL  ${name}: ${e.message}`);
  }
};
const eq = (a, b, what) => {
  if (a !== b) throw new Error(`${what}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
};

// A stand-in project with out/index.html; `fill` adds files to out/.
const dirs = [];
function finish(fill = () => {}) {
  const dir = mkdtempSync(join(tmpdir(), "static-extras-"));
  dirs.push(dir);
  const out = join(dir, "out");
  mkdirSync(out);
  copyFileSync(join(root, "security-headers.json"), join(dir, "security-headers.json"));
  writeFileSync(join(out, "index.html"), "<!doctype html><title>Languages</title>");
  writeFileSync(join(out, "404.html"), "<!doctype html><title>Not found</title>");
  mkdirSync(join(out, "_next/static/chunks"), { recursive: true });
  writeFileSync(join(out, "_next/static/chunks/app.js"), "");
  writeFileSync(join(out, "sw.js"), 'const BUILD = "dev";\n');
  fill(out);
  const run = spawnSync(process.execPath, [join(root, "scripts/static-extras.mjs"), out], { cwd: dir, encoding: "utf8" });
  return { out, status: run.status, log: run.stdout + run.stderr };
}

await test("writes _headers and .nojekyll, and leaves Next's 404.html alone", () => {
  const { out, status, log } = finish();
  eq(status, 0, `exit status (${log.trim()})`);
  eq(/Cross-Origin-Embedder-Policy: require-corp/.test(readFileSync(join(out, "_headers"), "utf8")), true, "COEP in _headers");
  eq(readFileSync(join(out, "404.html"), "utf8"), "<!doctype html><title>Not found</title>", "404.html untouched");
  eq(existsSync(join(out, ".nojekyll")), true, ".nojekyll");
});

await test("fails on a file over 24 MiB", () => {
  const { status, log } = finish((out) => {
    mkdirSync(join(out, "vendor"));
    const fd = openSync(join(out, "vendor", "model.bin"), "w");
    ftruncateSync(fd, 26 * 1024 * 1024);
    closeSync(fd);
  });
  eq(status, 1, "exit status");
  eq(/vendor\/model\.bin is 26\.0 MiB/.test(log), true, `names the file (${log.trim().split("\n").at(-1)})`);
});

await test("fails on more than 18,000 files", () => {
  const { status, log } = finish((out) => {
    for (let d = 0; d < 19; d++) {
      mkdirSync(join(out, `p${d}`));
      for (let i = 0; i < 1000; i++) writeFileSync(join(out, `p${d}`, `${i}.txt`), "");
    }
  });
  eq(status, 1, "exit status");
  eq(/1900\d files; keep it under 18000/.test(log), true, `says why (${log.trim().split("\n").at(-1)})`);
});

// A sitemap entry: the page's address and its English translation.
const entry = (loc, en) =>
  `<url><loc>https://example.org${loc}</loc><xhtml:link rel="alternate" hreflang="en" href="https://example.org${en}"/></url>`;
const sitemap = (out, entries) =>
  writeFileSync(join(out, "sitemap.xml"), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n${entries.join("\n")}\n</urlset>\n`);

await test("redirects old English tool addresses to the localized ones", () => {
  const { out, status, log } = finish((out) => {
    mkdirSync(join(out, "es"));
    for (const f of ["unir-pdf", "convertidor-pdf", "faq"]) writeFileSync(join(out, "es", `${f}.html`), "<!doctype html>");
    sitemap(out, [
      entry("/en/merge-pdf", "/en/merge-pdf"),
      entry("/es/unir-pdf", "/en/merge-pdf"),
      entry("/ja/merge-pdf", "/en/merge-pdf"),
      // A new page (not a tool's old address) and a page that kept its slug.
      entry("/es/convertidor-pdf", "/en/pdf-converter"),
      entry("/es/faq", "/en/faq"),
    ]);
  });
  eq(status, 0, `exit status (${log.trim()})`);
  eq(readFileSync(join(out, "_redirects"), "utf8"), "/es/merge-pdf /es/unir-pdf 301\n", "_redirects");
  const html = readFileSync(join(out, "es/merge-pdf.html"), "utf8");
  eq(/<meta http-equiv="refresh" content="0; url=\/es\/unir-pdf">/.test(html), true, `refresh (${html})`);
  eq(/<link rel="canonical" href="https:\/\/example\.org\/es\/unir-pdf">/.test(html), true, "canonical");
  eq(/<html lang="es">/.test(html), true, "language");
  eq(existsSync(join(out, "es/pdf-converter.html")) || existsSync(join(out, "ja/merge-pdf.html")), false, "no redirect for pages that didn't move");
});

await test("refuses a redirect over a real page", () => {
  const { status, log } = finish((out) => {
    mkdirSync(join(out, "es"));
    writeFileSync(join(out, "es/merge-pdf.html"), "<!doctype html><title>real</title>");
    sitemap(out, [entry("/es/unir-pdf", "/en/merge-pdf")]);
  });
  eq(status, 1, "exit status");
  eq(/es\/merge-pdf\.html is a page/.test(log), true, `says why (${log.trim().split("\n").at(-1)})`);
});

await test("fails on more than 2,000 redirects", () => {
  const { status, log } = finish((out) => {
    sitemap(out, Array.from({ length: 2001 }, (_, i) => entry(`/l${i}/unir-pdf`, "/en/merge-pdf")));
  });
  eq(status, 1, "exit status");
  eq(/2001 redirects; Cloudflare Pages takes 2000/.test(log), true, `says why (${log.trim().split("\n").at(-1)})`);
});

for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
