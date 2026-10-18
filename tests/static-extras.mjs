// The static build's finishing step (scripts/static-extras.mjs) on small
// stand-in builds: it writes the host files, and it refuses a build that
// Cloudflare Pages' free plan wouldn't take.
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
  // Untouched but for the policy's <meta> copy (tested below).
  eq(readFileSync(join(out, "404.html"), "utf8").replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, ""), "<!doctype html><title>Not found</title>", "404.html untouched");
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

await test("sends the Content-Security-Policy, and puts a <meta> copy first in every page's <head>", () => {
  const page = '<!DOCTYPE html><html lang="en"><head><meta charSet="utf-8"/><script src="/_next/static/chunks/app.js"></script></head><body></body></html>';
  const { out, status, log } = finish((out) => {
    mkdirSync(join(out, "en"));
    writeFileSync(join(out, "en", "compress-pdf.html"), page);
  });
  eq(status, 0, `exit status (${log.trim()})`);
  const policy = JSON.parse(readFileSync(join(root, "security-headers.json"), "utf8")).find((h) => h.key === "Content-Security-Policy")?.value ?? "";
  eq(policy.includes("connect-src 'self'"), true, "security-headers.json has a CSP");
  const headers = readFileSync(join(out, "_headers"), "utf8");
  eq(headers.includes(`Content-Security-Policy: ${policy}`), true, "CSP in _headers");
  eq(policy.includes("'unsafe-eval'"), false, "pages don't allow eval");
  // LibreOffice's worker scripts replace it with one that allows eval.
  const office = headers.match(/\/vendor\/:build\/libreoffice\/\*\n {2}! Content-Security-Policy\n {2}Content-Security-Policy: (.+)/)?.[1];
  eq(office, policy.replace("script-src 'self'", "script-src 'self' 'unsafe-eval'"), "LibreOffice's policy");
  const html = readFileSync(join(out, "en", "compress-pdf.html"), "utf8");
  const meta = html.match(/^<!DOCTYPE html><html lang="en"><head><meta http-equiv="Content-Security-Policy" content="([^"]+)"\/><meta charSet/);
  eq(!!meta, true, `meta first in <head> (${html.slice(0, 160)})`);
  eq(meta[1].includes("connect-src 'self'"), true, "meta has connect-src");
  // Browsers ignore frame-ancestors in a meta tag and warn about it.
  eq(meta[1].includes("frame-ancestors"), false, "meta leaves out frame-ancestors");
  // A page without a <head> tag still gets it before everything else.
  eq(readFileSync(join(out, "index.html"), "utf8").startsWith('<!doctype html><meta http-equiv="Content-Security-Policy"'), true, "index.html");
});

await test("fails when a page loads anything from another site", () => {
  const { status, log } = finish((out) => {
    writeFileSync(join(out, "about.html"),
      '<!doctype html><html><head><link rel="canonical" href="https://nopload.example/en/about"/><link rel="stylesheet" href="https://fonts.example/a.css"/></head>' +
      '<body><a href="https://github.com/x/y">source</a><img src="//cdn.example/pixel.gif"></body></html>');
    writeFileSync(join(out, "_next/static/chunks/app.css"), "@font-face{src:url(https://fonts.example/f.woff2)}");
  });
  eq(status, 1, "exit status");
  for (const url of ["https://fonts.example/a.css", "//cdn.example/pixel.gif", "https://fonts.example/f.woff2"]) {
    eq(log.includes(url), true, `names ${url} (${log.trim().split("\n").slice(-3).join(" | ")})`);
  }
  // Links and canonical URLs aren't loads.
  eq(log.includes("github.com") || log.includes("nopload.example"), false, "ignores links");
});

for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
