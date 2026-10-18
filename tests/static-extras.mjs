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
  fill(out);
  const run = spawnSync(process.execPath, [join(root, "scripts/static-extras.mjs"), out], { cwd: dir, encoding: "utf8" });
  return { out, status: run.status, log: run.stdout + run.stderr };
}

await test("writes _headers, 404.html and .nojekyll", () => {
  const { out, status, log } = finish();
  eq(status, 0, `exit status (${log.trim()})`);
  eq(/Cross-Origin-Embedder-Policy: require-corp/.test(readFileSync(join(out, "_headers"), "utf8")), true, "COEP in _headers");
  eq(existsSync(join(out, "404.html")), true, "404.html");
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

for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
