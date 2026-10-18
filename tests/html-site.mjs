// HTML to PDF in the static build, before the print dialog: a zipped site
// becomes one self-contained page, remote URLs are taken out so the page
// can't reach other hosts, and the page size, margins and screen width land
// in the page's CSS.
//
//   node tests/html-site.mjs
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { zipSync, strToU8 } from "fflate";
import { root, check, eq } from "./lib/load.mjs";

const results = { failed: 0 };
const test = check(results);
const out = mkdtempSync(join(tmpdir(), "html-site-"));
execFileSync(join(root, "node_modules/.bin/tsc"), ["--outDir", out, "--module", "esnext", "--target", "es2022", "--moduleResolution", "bundler", "--skipLibCheck", "--noCheck", "--lib", "es2022,dom", "src/lib/office/html.ts"], { cwd: root, stdio: "inherit" });
const { siteFromZip, blockRemote, htmlPage } = await import(pathToFileURL(join(out, "html.js")).href);

// A 1×1 PNG.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

await test("zip: index.html with its stylesheet, images and fonts inlined", async () => {
  const zip = zipSync({
    "site/index.html": strToU8(`<!doctype html><html><head><link rel="stylesheet" href="style.css"><link rel="stylesheet" href="./css/more.css"></head>
      <body><h1>Hello</h1><img src="logo.png" alt=""><img src="img/a%20b.png" alt=""><a href="other.html">next</a></body></html>`),
    "site/style.css": strToU8("h1 { color: rgb(255, 0, 0); } body { background: url(logo.png); }"),
    "site/css/more.css": strToU8("@font-face { font-family: X; src: url('../fonts/x.woff') } p { background: url(\"../logo.png\") }"),
    "site/logo.png": PNG,
    "site/img/a b.png": PNG,
    "site/fonts/x.woff": new Uint8Array([1, 2, 3]),
    "site/other.html": strToU8("<p>other</p>"),
  });
  const html = await siteFromZip(zip);
  eq(/Hello/.test(html), true, "index.html chosen");
  eq(/href="style\.css"|href="\.\/css/.test(html), false, "stylesheets no longer relative");
  eq((html.match(/src="data:image\/png;base64,/g) ?? []).length, 2, "both images inlined, including the escaped name");
  const css = [...html.matchAll(/data:text\/css;base64,([A-Za-z0-9+/=]+)/g)].map((m) => Buffer.from(m[1], "base64").toString());
  eq(css.length, 2, "two stylesheets");
  eq(css[0].includes("rgb(255, 0, 0)") && /url\("?data:image\/png;base64,/.test(css[0]), true, "stylesheet kept, its image inlined");
  eq(/url\("?data:font\/woff;base64,/.test(css[1]) && /url\("?data:image\/png/.test(css[1]), true, "paths resolved from the stylesheet's own folder");
  eq(html.includes('href="other.html"'), true, "links between pages left alone");
});

await test("zip without an HTML page is refused", async () => {
  let error = null;
  try {
    await siteFromZip(zipSync({ "a.txt": strToU8("x") }));
  } catch (e) {
    error = e;
  }
  eq(/no HTML page/.test(error?.message ?? ""), true, `error: ${error?.message}`);
});

await test("remote URLs are replaced and counted; links stay", () => {
  const { html, blocked } = blockRemote(`<!doctype html><html><head>
    <base href="https://example.com/">
    <meta http-equiv="refresh" content="0;url=https://example.com/">
    <link rel="stylesheet" href="https://cdn.example.com/a.css">
    <link rel="icon" href="//cdn.example.com/i.png">
    <script src="https://cdn.example.com/t.js"></script>
    <style>@import url("https://fonts.example.com/f.css"); @import 'http://x.example/y.css'; .a { background: url('https://img.example.com/b.png') }</style>
    </head><body style="background-image:url(http://img.example.com/c.png)">
    <img src="https://img.example.com/x.png" srcset="https://img.example.com/x2.png 2x">
    <img src='HTTPS://IMG.EXAMPLE.COM/Y.PNG'>
    <iframe src="https://example.com/embed"></iframe>
    <video poster="https://example.com/p.jpg"><source src="https://example.com/v.mp4"></video>
    <a href="https://example.com/keep">a link</a>
    <img src="data:image/png;base64,AAAA"><img src="local.png">
    </body></html>`);
  const loading = html.replace(/<a [^>]*>/g, "");
  eq(/(?:https?:)?\/\/[a-z]/i.test(loading.replace(/http:\/\/www\.w3\.org\/2000\/svg/g, "")), false, `no remote URL left outside links: ${loading.match(/.{30}(?:https?:)?\/\/[a-z].{30}/i)?.[0]}`);
  eq(html.includes('href="https://example.com/keep"'), true, "link kept");
  eq(html.includes("data:image/png;base64,AAAA") && html.includes('src="local.png"'), true, "data and relative URLs kept");
  eq(blocked, 15, "count");
  eq(/<meta http-equiv="Content-Security-Policy" content="default-src 'none'/.test(html), true, "CSP as a backstop");
  eq(html.indexOf("Content-Security-Policy") < html.indexOf("<style"), true, "CSP before anything that loads");
});

await test("page size, orientation, margins and screen width", () => {
  const page = htmlPage("<!doctype html><html><head><title>x</title></head><body>hi</body></html>", { pageSize: "a3", orientation: "landscape", margin: "none", screenWidth: "390" });
  eq(/@page \{ size: A3 landscape; margin: 0(mm)?; \}/.test(page), true, `@page: ${page.match(/@page[^}]*}/)?.[0]}`);
  eq(/width: 390px/.test(page), true, "screen width");
  const fit = htmlPage("<p>x</p>", {});
  eq(/@page \{ size: A4 portrait; margin: 12mm; \}/.test(fit), true, `default @page: ${fit.match(/@page[^}]*}/)?.[0]}`);
  eq(/zoom/.test(fit), false, "fit to page by default");
  eq(/size: A5 portrait; margin: 25mm/.test(htmlPage("<p>x</p>", { pageSize: "a5", margin: "large" })), true, "A5, large margin");
  eq(/size: letter portrait/.test(htmlPage("<p>x</p>", { pageSize: "letter" })), true, "letter");
});

process.exit(results.failed ? 1 : 0);
