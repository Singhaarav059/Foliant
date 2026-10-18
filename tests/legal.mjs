// Legal checks on the static build: every component the site ships comes
// with its licence text and a source link, the licences page lists them
// (LibreOffice as MPL-2.0 with its source), the privacy policy and terms say
// who runs the site, and every page offers a way to get in touch.
//
//   npm run build:static
//   node tests/legal.mjs
//
// The last check starts a release build with no operator set, which must stop
// at once (it runs the server build, so out/ is left alone even if it doesn't).
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join, sep } from "node:path";
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
const ok = (cond, what) => {
  if (!cond) throw new Error(what);
};
const read = (path) => readFileSync(join(out, path), "utf8");
const text = (path) => read(path).replace(/<script[\s\S]*?<\/script>/g, "").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ");
const hrefs = (path) => [...read(path).matchAll(/<a\b[^>]*\shref="([^"]+)"/g)].map((m) => m[1].replaceAll("&amp;", "&"));

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
// The engines' folder, named by scripts/vendor.mjs after the hash of its files.
const vendorDir = readFileSync(join(root, "src/lib/vendor.ts"), "utf8").match(/VENDOR_VERSION = "([0-9a-f]{12})"/)?.[1] ?? "-";
// Wherever under /vendor scripts/vendor.mjs put licenses.json.
const find = (dir, depth) => existsSync(join(dir, "licenses.json")) ? dir
  : depth ? readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => find(join(dir, e.name), depth - 1)).find(Boolean) : undefined;
const licDir = find(join(out, "vendor"), 2) ?? join(out, "vendor", "-");
const licUrl = `/${licDir.slice(out.length + 1).split(sep).join("/")}/`;
const manifest = () => JSON.parse(readFileSync(join(licDir, "licenses.json"), "utf8"));
// The hash scripts/vendor.mjs names a folder after.
const hashOf = (dir) => {
  const hash = createHash("sha256");
  const walk = (d) => readdirSync(d, { withFileTypes: true })
    .sort((a, b) => (a.name < b.name ? -1 : 1))
    .forEach((e) => (e.isDirectory() ? walk(join(d, e.name)) : hash.update(join(d, e.name).slice(dir.length)).update(readFileSync(join(d, e.name)))));
  walk(dir);
  return hash.digest("hex").slice(0, 12);
};
// A licence file's sections by title: "=== name version (licence), source ===".
const sections = (file) => {
  const parts = readFileSync(join(licDir, file), "utf8").split(/^=== (.+) ===$/m);
  return new Map(parts.slice(1).flatMap((title, i) => (i % 2 ? [] : [[title, parts[i + 2]]])));
};
const sectionOf = (all, prefix) => [...all].find(([title]) => title.startsWith(prefix))?.[1];
// The licence and notice files a package ships, read from node_modules
// rather than trusted to scripts/vendor.mjs.
const shipped = (name, version) => {
  const dir = join(root, "node_modules", name);
  if (!existsSync(join(dir, "package.json")) || JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).version !== version) return null;
  return readdirSync(dir).filter((f) => /^(licen[cs]e|notice|copying)/i.test(f)).map((f) => [f, readFileSync(join(dir, f), "utf8").trim()]);
};
// Every package whose files scripts/vendor.mjs serves from /vendor.
const vendored = [
  "pdfjs-dist", "@neslinesli93/qpdf-wasm", "@jsquash/jpeg", "@embedpdf/pdfium", "tesseract.js", "tesseract.js-core",
  "onnxruntime-web", "pdfmarkdown-ppocrv5-models", "@matbee/libreoffice-converter",
  ...Object.keys(pkg.dependencies).filter((d) => d.startsWith("@fontsource/") || d.startsWith("@tesseract.js-data/")),
];

await test("every vendored package ships its licence", () => {
  ok(existsSync(join(licDir, "licenses.json")), `no out/vendor/${vendorDir}/licenses/licenses.json`);
  const { components } = manifest();
  const missing = [];
  for (const name of vendored) {
    const c = components.find((x) => x.packages.some((p) => p.name === name));
    if (!c) { missing.push(`${name} not listed`); continue; }
    const p = c.packages.find((x) => x.name === name);
    const file = join(licDir, c.file);
    if (!existsSync(file)) { missing.push(`${name}: no ${c.file}`); continue; }
    const body = readFileSync(file, "utf8");
    if (!body.includes(`=== ${name} ${p.version}`)) missing.push(`${name}: not in ${c.file}`);
    if (!p.license || !/^https:\/\//.test(p.source)) missing.push(`${name}: licence ${p.license}, source ${p.source}`);
  }
  ok(!missing.length, missing.join("; "));
  // The site's own font is served by Next, not from /vendor.
  ok(components.some((c) => c.name === "Geist" && readFileSync(join(licDir, c.file), "utf8").includes("SIL Open Font License")), "no Geist licence");
});

// A section header alone isn't a licence: each package's section must hold
// the texts of the licence and notice files the package itself ships.
await test("each package's own licence and notice files are reproduced", () => {
  const { components, libraries, librariesFile } = manifest();
  const missing = [];
  const check = (all, p) => {
    const files = shipped(p.name, p.version);
    if (!files) return;
    const body = sectionOf(all, `${p.name} ${p.version} (`) ?? "";
    for (const [f, text] of files) if (!body.includes(text)) missing.push(`${p.name}/${f}`);
  };
  for (const c of components.filter((x) => x.packages.length)) {
    const all = sections(c.file);
    c.packages.forEach((p) => check(all, p));
  }
  const all = sections(librariesFile);
  libraries.forEach((p) => check(all, p));
  ok(!missing.length, `${missing.length} files missing, e.g. ${missing.slice(0, 4).join(", ")}`);
  const has = (file, text) => readFileSync(join(licDir, file), "utf8").includes(text);
  for (const file of ["noto.txt", "pdfa-fonts.txt"]) {
    const fonts = [...sections(file).values()];
    ok(fonts.every((b) => b.includes("SIL Open Font License")), `${file}: a font without the OFL text`);
  }
  ok(has("pdfium.txt", "PDFium Authors"), "pdfium.txt has no LICENSE.pdfium");
  const codec = readFileSync(join(root, "node_modules/@jsquash/jpeg/codec/LICENSE.codec.md"), "utf8").trim();
  ok(has("mozjpeg.txt", codec), "mozjpeg.txt has no LICENSE.codec.md");
});

// The service worker starts a new cache, and the browser downloads every
// engine again, whenever the engines' folder hash changes. Licence texts
// change with any library update, so they hash into a folder of their own.
await test("licence texts don't change the engines' folder", () => {
  const engines = join(out, "vendor", vendorDir);
  ok(existsSync(engines), `no out/vendor/${vendorDir}`);
  ok(!licDir.startsWith(engines + sep), `licence texts are inside /vendor/${vendorDir}/, so any library update renames the engines`);
  ok(hashOf(engines) === vendorDir, `out/vendor/${vendorDir} holds files outside its hash`);
  ok(/^[0-9a-f]{12}$/.test(basename(licDir)) && hashOf(licDir) === basename(licDir), `${licUrl} isn't named after the hash of its files (/vendor/* is cached as immutable)`);
});

await test("compiled-in projects are named with licence and source", () => {
  const includes = manifest().components.flatMap((c) => c.includes ?? []);
  for (const [name, licence] of [["LibreOffice", "MPL-2.0"], ["PDFium", "BSD-3-Clause"], ["qpdf", "Apache-2.0"], ["Tesseract", "Apache-2.0"], ["MozJPEG", ""]]) {
    const i = includes.find((x) => x.name.startsWith(name));
    ok(i && i.license.includes(licence) && /^https:\/\//.test(i.source), `${name}: ${JSON.stringify(i)}`);
  }
  const lo = manifest().components.find((c) => c.includes?.some((i) => i.name === "LibreOffice"));
  ok(readFileSync(join(licDir, lo.file), "utf8").includes("Mozilla Public License Version 2.0"), "no MPL-2.0 text with LibreOffice");
  // MPL §3.2: the source of the exact build, not of LibreOffice in general.
  const source = includes.find((i) => i.name === "LibreOffice").source;
  ok(/^https:\/\/git\.libreoffice\.org\/core\/\+\/[0-9a-f]{40}$/.test(source), `LibreOffice source names no commit: ${source}`);
  // Notices that a binary distribution must reproduce, not just link to.
  const included = (file, name) => sectionOf(sections(file), `Includes ${name} (`) ?? "";
  ok(/Copyright \(C\) 2001-\d{4} Leptonica/.test(included("tesseract.txt", "Leptonica")), "no Leptonica licence text");
  ok(/Redistributions in binary form must reproduce/.test(included("tesseract.txt", "Leptonica")), "Leptonica licence incomplete");
  ok(/qpdf is copyright/.test(included("qpdf.txt", "qpdf")) && /Apache License/.test(included("qpdf.txt", "qpdf")), "no qpdf NOTICE with its licence");
});

await test("every library in the page code is listed with its licence text", () => {
  const { libraries, librariesFile } = manifest();
  ok(libraries.length > 50, `${libraries.length} libraries`);
  for (const name of ["react", "react-dom", "next", "pdf-lib", "@pdf-lib/fontkit", "jszip", "lucide-react"])
    ok(libraries.some((l) => l.name === name), `${name} missing`);
  const body = readFileSync(join(licDir, librariesFile), "utf8");
  const absent = libraries.filter((l) => !body.includes(`=== ${l.name} ${l.version}`));
  ok(!absent.length, `${absent.length} libraries without text, e.g. ${absent[0]?.name}`);
});

await test("the licences page lists LibreOffice as MPL-2.0 with its source, in every language", () => {
  ok(existsSync(join(out, "en/licenses.html")), "no out/en/licenses.html");
  const page = text("en/licenses.html");
  ok(/LibreOffice/.test(page) && /MPL-2\.0/.test(page), "LibreOffice or MPL-2.0 missing");
  const links = hrefs("en/licenses.html");
  ok(links.some((h) => h.startsWith("https://git.libreoffice.org/")), "no LibreOffice source link");
  ok(links.some((h) => h.startsWith(licUrl)), "no link to licence texts");
  const langs = readdirSync(out).filter((d) => existsSync(join(out, d, "404.html")));
  const absent = langs.filter((l) => !existsSync(join(out, l, "licenses.html")));
  ok(!absent.length, `missing in ${absent.join(", ")}`);
});

await test("every page links the licences page", () => {
  for (const page of ["en/merge-pdf.html", "de/about.html", "ja.html"]) {
    const lang = page.split(/[/.]/)[0];
    ok(hrefs(page).includes(`/${lang}/licenses`), `${page} has no link to /${lang}/licenses`);
  }
});

await test("privacy policy and terms say who runs the site and how to reach them", () => {
  for (const page of ["en/privacy.html", "en/terms.html", "fr/privacy.html"]) {
    const html = read(page);
    const section = html.match(/<section id="operator">([\s\S]*?)<\/section>/)?.[1];
    ok(section, `${page}: no operator section`);
    if (process.env.NEXT_PUBLIC_OPERATOR_NAME) ok(section.includes(process.env.NEXT_PUBLIC_OPERATOR_NAME), `${page}: operator name missing`);
    ok(/\S/.test(section.replace(/<[^>]+>/g, "")), `${page}: operator section is empty`);
  }
  ok(/Governing law/.test(text("en/terms.html")), "terms name no governing law");
});

await test("the privacy policy says which engines download from this site", () => {
  const page = text("en/privacy.html");
  ok(/LibreOffice/.test(page) && /PaddleOCR/.test(page), "LibreOffice or PaddleOCR not mentioned");
});

await test("every page offers a contact and an issues link", () => {
  const repo = pkg.repository?.url?.replace(/^git\+/, "").replace(/\.git$/, "");
  ok(repo?.startsWith("https://"), "package.json has no repository URL");
  const issues = `${process.env.NEXT_PUBLIC_REPO_URL || repo}/issues`;
  ok(hrefs("en/about.html").some((h) => h.startsWith(issues)), `about page has no ${issues} link`);
  ok(!/contact page/i.test(text("en/about.html")), "about page points to a contact page that doesn't exist");
  // The footer's Contact column entry: the operator's address, else issues.
  const footer = read("en/merge-pdf.html").match(/<footer[\s\S]*<\/footer>/)?.[0] ?? "";
  ok(/<a\b[^>]*href="(mailto:|https:)[^"]*"[^>]*>Contact<\/a>/.test(footer), "footer has no Contact link");
});

await test("a release build without an operator stops", () => {
  const env = {
    ...process.env, FOLIANT_RELEASE: "1", FOLIANT_STATIC: "", NEXT_PUBLIC_SITE_URL: "https://pdf.example.org",
    NEXT_PUBLIC_OPERATOR_NAME: "", NEXT_PUBLIC_OPERATOR_COUNTRY: "", NEXT_PUBLIC_OPERATOR_CONTACT: "",
  };
  const run = spawnSync(join(root, "node_modules/.bin/next"), ["build"], { cwd: root, env, encoding: "utf8", timeout: 300000 });
  const log = run.stdout + run.stderr;
  ok(run.status !== 0, "the release build finished without an operator");
  for (const name of ["NEXT_PUBLIC_OPERATOR_NAME", "NEXT_PUBLIC_OPERATOR_COUNTRY", "NEXT_PUBLIC_OPERATOR_CONTACT"])
    ok(log.includes(`${name} is not set`), `${name} not reported: ${log.slice(-300)}`);
});

process.exit(results.failed ? 1 : 0);
