// The browser add-on's build (scripts/build-extension.mjs): both manifests ask
// for the least they can, the store zips hold exactly the add-on's files, and
// nothing in them talks to any server but the site the build names.
//
//   node tests/extension.mjs
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { unzipSync } from "fflate";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SITE = "https://pdf.test-site.org";
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
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${what}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
};
const ok = (cond, what) => {
  if (!cond) throw new Error(what);
};

const dirs = [];
function build(env = {}, args = []) {
  const out = mkdtempSync(join(tmpdir(), "nopload-ext-"));
  dirs.push(out);
  const r = spawnSync(process.execPath, [join(root, "scripts/build-extension.mjs"), "--out", out, ...args], {
    env: { ...process.env, NOPLOAD_RELEASE: "", NEXT_PUBLIC_SITE_URL: "", NOPLOAD_EXTENSION_SITE_URL: "", ...env },
    encoding: "utf8",
  });
  return { out, status: r.status, output: r.stdout + r.stderr };
}

const { out, status, output } = build({ NOPLOAD_EXTENSION_SITE_URL: SITE });
if (status !== 0) {
  console.log(`FAIL  build: ${output}`);
  process.exit(1);
}
const { version } = JSON.parse(readFileSync(join(root, "extension/src/manifest.json"), "utf8"));
const zips = Object.fromEntries(["chrome", "firefox"].map((b) => [b, unzipSync(readFileSync(join(out, `nopload-${b}-${version}.zip`)))]));
const text = (b, path) => new TextDecoder().decode(zips[b][path]);
const manifest = (b) => JSON.parse(text(b, "manifest.json"));
const FILES = [
  "background.js", "content.js", "icons/128.png", "icons/16.png", "icons/32.png", "icons/48.png",
  "manifest.json", "open.css", "open.html", "open.js",
];

for (const b of ["chrome", "firefox"]) {
  await test(`${b}: the zip holds exactly the add-on's files`, () => {
    eq(Object.keys(zips[b]).sort(), FILES, "files");
    for (const f of FILES) ok(Buffer.from(zips[b][f]).equals(readFileSync(join(out, b, f))), `${f} differs from the unpacked build`);
  });

  await test(`${b}: Manifest V3 with only contextMenus and activeTab`, () => {
    const m = manifest(b);
    eq(m.manifest_version, 3, "manifest_version");
    ok(/^\d+\.\d+\.\d+$/.test(m.version), `version ${m.version}`);
    eq(m.permissions, ["contextMenus", "activeTab"], "permissions");
    eq(m.host_permissions, undefined, "host_permissions (sites are asked for one at a time)");
    eq(m.optional_host_permissions, ["https://*/*", "http://*/*"], "optional_host_permissions");
    eq(m.optional_permissions, undefined, "optional_permissions");
    for (const key of ["web_accessible_resources", "externally_connectable", "content_security_policy", "update_url", "key"])
      eq(m[key], undefined, key);
  });

  await test(`${b}: the content script runs on the built site only`, () => {
    const m = manifest(b);
    eq(m.content_scripts, [{ matches: [`${SITE}/*`], js: ["content.js"], run_at: "document_idle" }], "content_scripts");
    eq(m.homepage_url, `${SITE}/`, "homepage_url");
  });

  await test(`${b}: every file the manifest names is in the zip`, () => {
    const m = manifest(b);
    const named = [
      ...Object.values(m.icons), ...Object.values(m.action.default_icon), ...m.content_scripts.flatMap((c) => c.js),
      ...(m.background.scripts ?? [m.background.service_worker]),
    ];
    for (const f of named) ok(f in zips[b], `${f} is missing`);
    ok(text(b, "open.html").includes('src="open.js"'), "open.html loads open.js");
  });

  await test(`${b}: no placeholders, remote code or other servers`, () => {
    for (const f of FILES.filter((f) => /\.(js|html|css|json)$/.test(f))) {
      const src = text(b, f);
      ok(!/__[A-Z_]+__/.test(src), `${f} still has a placeholder: ${src.match(/__[A-Z_]+__/)?.[0]}`);
      ok(!/\beval\(|new Function\(|importScripts\(|<script[^>]+https?:/.test(src), `${f} loads or evaluates code`);
      // Store links and the match-all patterns aside, the only address is the site.
      const urls = (src.match(/https?:\/\/[^\s"'`)]+/g) ?? []).filter((u) => !u.startsWith(SITE) && !/^https?:\/\/\*/.test(u));
      eq(urls, [], `addresses in ${f}`);
    }
    ok(text(b, "background.js").includes(`const SITE = "${SITE}";`), "background.js opens the built site");
    ok(/const MAX_BYTES = \d+ \* 1024 \* 1024/.test(text(b, "background.js")), "background.js has the size limit");
  });
}

await test("chrome: a service worker background", () => {
  eq(manifest("chrome").background, { service_worker: "background.js" }, "background");
  eq(manifest("chrome").browser_specific_settings, undefined, "browser_specific_settings");
});

await test("firefox: an event page, a fixed id and no data collected", () => {
  const m = manifest("firefox");
  eq(m.background, { scripts: ["background.js"] }, "background");
  eq(m.browser_specific_settings.gecko.id, "open-in@nopload", "gecko id");
  eq(m.browser_specific_settings.gecko.data_collection_permissions, { required: ["none"] }, "data_collection_permissions");
  ok(Number.parseFloat(m.browser_specific_settings.gecko.strict_min_version) >= 140, "strict_min_version below 140 (needed for data_collection_permissions)");
});

await test("the same source builds the same zips", () => {
  const again = build({ NOPLOAD_EXTENSION_SITE_URL: SITE });
  for (const b of ["chrome", "firefox"]) {
    const name = `nopload-${b}-${version}.zip`;
    ok(readFileSync(join(out, name)).equals(readFileSync(join(again.out, name))), `${name} differs`);
  }
});

await test("the site comes from NEXT_PUBLIC_SITE_URL when the add-on's own setting is unset", () => {
  const r = build({ NEXT_PUBLIC_SITE_URL: "https://other.test-site.org/" });
  eq(r.status, 0, `status (${r.output})`);
  ok(readFileSync(join(r.out, "chrome/background.js"), "utf8").includes('const SITE = "https://other.test-site.org";'), "site");
});

await test("a release build refuses the placeholder, a test host and a bad address", () => {
  const placeholder = build({ NOPLOAD_RELEASE: "1" });
  ok(placeholder.status !== 0 && /Release build stopped/.test(placeholder.output), "placeholder accepted");
  const testHost = build({ NOPLOAD_RELEASE: "1", NOPLOAD_EXTENSION_SITE_URL: SITE }, ["--test-host", "http://127.0.0.1/*"]);
  ok(testHost.status !== 0, "test host accepted");
  const path = build({ NOPLOAD_EXTENSION_SITE_URL: "https://pdf.test-site.org/app" });
  ok(path.status !== 0 && /without a path/.test(path.output), "a path accepted");
  const live = build({ NOPLOAD_RELEASE: "1", NOPLOAD_EXTENSION_SITE_URL: SITE });
  eq(live.status, 0, `release with the site set (${live.output})`);
});

await test("the store listing ships beside the zips and says no data is collected", () => {
  ok(existsSync(join(out, "store-listing.md")), "store-listing.md missing");
  const listing = readFileSync(join(root, "extension/store-listing.md"), "utf8");
  ok(/collects no data/i.test(listing), "privacy statement");
  for (const p of manifest("chrome").permissions) ok(listing.includes(`**${p}**`), `no justification for ${p}`);
});

for (const d of dirs) rmSync(d, { recursive: true, force: true });
console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
