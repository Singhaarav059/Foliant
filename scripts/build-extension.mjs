// Builds the "Open in Nopload" browser add-on (extension/src) for each store:
//
//   extension/dist/chrome/                 unpacked, for chrome://extensions and edge://extensions
//   extension/dist/firefox/                unpacked, for about:debugging
//   extension/dist/nopload-chrome-<v>.zip  Chrome Web Store and Microsoft Edge Add-ons
//   extension/dist/nopload-firefox-<v>.zip Firefox Add-ons (AMO)
//
// The site the add-on opens is fixed at build time: NOPLOAD_EXTENSION_SITE_URL,
// else NEXT_PUBLIC_SITE_URL, else the placeholder in src/lib/brand.ts. With
// NOPLOAD_RELEASE=1 the build stops while it is still the placeholder.
//
// Usage: node scripts/build-extension.mjs [--out dir] [--test-host <match pattern>]
//   --test-host adds a host permission, so tests/e2e/extension.mjs can fetch
//   from a local server without the permission prompt. Never for a store zip.
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { zipSync } from "fflate";
import sharp from "sharp";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "extension/src");
const { values: args } = parseArgs({ options: { out: { type: "string" }, "test-host": { type: "string" } } });
const out = args.out ?? join(root, "extension/dist");

// The same setting and placeholder the site uses (src/lib/brand.ts).
const brand = readFileSync(join(root, "src/lib/brand.ts"), "utf8");
const placeholder = brand.match(/NEXT_PUBLIC_SITE_URL:\s*\{[^}]*placeholder:\s*"([^"]+)"/)[1];
const site = (process.env.NOPLOAD_EXTENSION_SITE_URL?.trim() || process.env.NEXT_PUBLIC_SITE_URL?.trim() || placeholder).replace(/\/+$/, "");
const local = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(site);
if (!/^https:\/\/[^/]+$/.test(site) && !local) throw new Error(`The site URL must be https://host without a path (got ${site})`);
if (process.env.NOPLOAD_RELEASE === "1" && (site === placeholder || local || args["test-host"]))
  throw new Error(`Release build stopped: set NOPLOAD_EXTENSION_SITE_URL or NEXT_PUBLIC_SITE_URL to the live site (got ${site})`);

const maxMb = readFileSync(join(root, "src/lib/tools.ts"), "utf8").match(/LIMITS\s*=\s*\{[^}]*mb:\s*(\d+)/)[1];
const siteUrl = new URL(site);
// Match patterns take no port; content.js checks the full origin itself.
const fill = (text) =>
  text
    .replaceAll("__SITE_URL__", site)
    .replaceAll("__SITE_MATCH__", `${siteUrl.protocol}//${siteUrl.hostname}/*`)
    .replaceAll("__MAX_MB__", maxMb);

const base = JSON.parse(fill(readFileSync(join(src, "manifest.json"), "utf8")));
if (args["test-host"]) base.host_permissions = [args["test-host"]];

const variants = {
  chrome: base,
  firefox: {
    ...base,
    // Firefox runs MV3 backgrounds as event pages, not service workers.
    background: { scripts: ["background.js"] },
    browser_specific_settings: {
      gecko: {
        // Permanent once published on AMO.
        id: "open-in@nopload",
        strict_min_version: "140.0",
        data_collection_permissions: { required: ["none"] },
      },
    },
  },
};

const files = (dir) =>
  readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? files(join(dir, f)) : [join(dir, f)]));

// The add-on's icon, drawn from the site's (public/icon.svg).
const svg = readFileSync(join(root, "public/icon.svg"));
const icons = Object.fromEntries(
  await Promise.all([16, 32, 48, 128].map(async (n) => [`icons/${n}.png`, await sharp(svg, { density: 384 }).resize(n, n).png().toBuffer()])),
);

rmSync(out, { recursive: true, force: true });
const { version } = base;
for (const [name, manifest] of Object.entries(variants)) {
  const entries = { "manifest.json": Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`), ...icons };
  for (const file of files(src)) {
    const path = relative(src, file).split("\\").join("/");
    if (path === "manifest.json") continue;
    entries[path] = /\.(js|html|css)$/.test(path) ? Buffer.from(fill(readFileSync(file, "utf8"))) : readFileSync(file);
  }
  const dir = join(out, name);
  for (const [path, data] of Object.entries(entries)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), data);
  }
  // Sorted names and a fixed date (zips store local time), so the same
  // source gives the same zip.
  const mtime = new Date(2026, 0, 1);
  const zip = zipSync(
    Object.fromEntries(Object.keys(entries).sort().map((p) => [p, [new Uint8Array(entries[p]), { mtime }]])),
    { level: 9 },
  );
  writeFileSync(join(out, `nopload-${name}-${version}.zip`), zip);
}
cpSync(join(root, "extension/store-listing.md"), join(out, "store-listing.md"));
console.log(`Built the add-on ${version} for ${site} in ${relative(root, out) || out}`);
