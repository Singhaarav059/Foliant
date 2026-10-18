// Hostile inputs: generates the corpus (gen.mjs), runs every engine on every
// fixture in its own process with a hard timeout (oracles.mjs), and holds
// each case to the oracles plus a time and a memory limit.
//
//   node tests/robustness/run.mjs                 every case; exits 1 on any failure
//   node tests/robustness/run.mjs --known         exits 1 only on a failure that
//                                                 known-failures.json doesn't list (or lists
//                                                 as failing another way), or on a listed
//                                                 case that now passes (CI)
//   node tests/robustness/run.mjs --known --prune also drops listed cases that pass
//   node tests/robustness/run.mjs "redact|split"  only cases whose "tool[:variant] fixture" matches
//   --jobs N                                      cases in parallel (default up to 3)
//
// ROBUST_TIME_LIMIT_S (60), ROBUST_RSS_MB (800) and ROBUST_KILL_S (180) set the limits;
// ROBUST_KEEP=1 keeps the corpus and every output for a look afterwards.
// known-failures.json maps each failing case to the backlog item that fixes it
// ("why") and to how it fails today ("fails"): one text per problem, as the
// FAIL line prints it, "error: <message>" for an error, and "crash: ..." only
// for a case that may be killed or crash. Every part of the failure must
// contain one of those texts, so a listed case that starts to fail another way
// (a new problem, an error, a hang or a crash) counts as a new failure.
// When you fix one, run with --known --prune and commit the shorter list.
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const jobsArg = args.indexOf("--jobs");
const concurrency = jobsArg >= 0 ? Number(args[jobsArg + 1]) : Math.max(1, Math.min(3, availableParallelism() - 1));
const filterArg = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--jobs");
const filter = filterArg ? new RegExp(filterArg) : null;
const TIME_LIMIT = Number(process.env.ROBUST_TIME_LIMIT_S ?? 60) * 1000;
const RSS_LIMIT = Number(process.env.ROBUST_RSS_MB ?? 800);
const KILL = Number(process.env.ROBUST_KILL_S ?? 180) * 1000;
const knownPath = join(here, "known-failures.json");
const known = JSON.parse(readFileSync(knownPath, "utf8"));
for (const [k, v] of Object.entries(known)) {
  if (typeof v?.why !== "string" || !Array.isArray(v.fails) || !v.fails.length) throw new Error(`known-failures.json: "${k}" needs "why" and a non-empty "fails" list`);
}

const work = mkdtempSync(join(tmpdir(), "robust-"));
const corpus = join(work, "corpus"), out = join(work, "out"), build = join(work, "build");
mkdirSync(build);
const env = { ...process.env, NOPLOAD_ROBUST_BUILD: build };
// Also on an early exit (gen.mjs failing); ROBUST_KEEP keeps everything.
if (!process.env.ROBUST_KEEP) process.on("exit", () => rmSync(work, { recursive: true, force: true }));

// The generator compiles the engines first; every case reuses that build.
await new Promise((resolve, reject) => {
  const gen = spawn(process.execPath, [join(here, "gen.mjs"), corpus], { env, stdio: ["ignore", "ignore", "inherit"] });
  gen.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`gen.mjs exited with ${code}`))));
});
const manifest = JSON.parse(readFileSync(join(corpus, "manifest.json"), "utf8"));
const fixtures = Object.keys(manifest);

const cases = [];
const core = ["merge", "split", "rotate", "compress", "watermark", "pagenumbers", "word", "excel", "images", "redact", "pdfa", "repair", "protect"];
for (const f of fixtures) for (const t of core) cases.push([t, f, ""]);
for (const f of fixtures.filter((f) => manifest[f].encrypted).concat("base.pdf")) cases.push(["unlock", f, ""], ["unlock", f, "wrong"]);
for (const f of ["base.pdf", "img-ccitt.pdf", "img-jbig2.pdf", "img-jpx.pdf", "odd-boxes.pdf", "huge-page.pdf", "zero-pages.pdf", "enc-aes256-owner.pdf", "dup-ids.pdf", "malformed-content.pdf", "tiny-page.pdf", "scanned.pdf", "scanned-rot90.pdf", "incremental.pdf", "bomb-image.pdf", "huge-scan.pdf"]) {
  cases.push(["ocr", f, f === "huge-page.pdf" ? "150" : ""]);
}
for (const f of ["base.pdf", "book-links.pdf", "odd-boxes.pdf", "annots.pdf", "acroform-unicode.pdf", "attachments.pdf", "dup-ids.pdf", "incremental.pdf", "cyclic-tree.pdf", "zero-pages.pdf", "enc-aes256-owner.pdf", "enc-rc4-40-owner.pdf"]) {
  cases.push(["extract", f, ""], ["organize", f, ""]);
}
for (const v of ["at", "dashdash", "dash", "unicode", "long", "space", "empty"]) cases.push(["protect", "base.pdf", v]);
for (const f of ["base.pdf", "pages-1500.pdf"]) cases.push(["split", f, "size"], ["split", f, "ranges"]);
for (const v of ["hindi", "cjk", "under", "mosaic"]) for (const f of ["base.pdf", "odd-boxes.pdf"]) cases.push(["watermark", f, v]);
for (const f of ["base.pdf", "odd-boxes.pdf"]) cases.push(["redact", f, "labels"]);
cases.push(["excel", "base.pdf", "colonname"], ["redact", "huge-page.pdf", "huge"]);
for (const f of ["base.pdf", "odd-boxes.pdf", "scripts.pdf"]) cases.push(["word", f, "exact"]);
for (const f of fixtures.filter((f) => f.startsWith("img-"))) cases.push(["compress", f, "extreme"]);

const key = ([tool, fixture, variant]) => `${tool}${variant ? ":" + variant : ""} ${fixture}`;
const todo = cases.filter((c) => !filter || filter.test(key(c)));

function run([tool, fixture, variant]) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(process.execPath, ["--max-old-space-size=4096", join(here, "oracles.mjs"), corpus, out, tool, fixture, variant], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    let killed = false;
    const timer = setTimeout(() => { killed = true; child.kill("SIGKILL"); }, KILL);
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      const wall = Date.now() - t0;
      const line = stdout.split("\n").find((l) => l.startsWith("RESULT "));
      const r = line ? JSON.parse(line.slice(7)) : { tool, fixture, variant, ok: false, problems: [], crash: killed ? `killed after ${KILL / 1000} s` : `exited with ${signal ?? code}: ${stderr.trim().split("\n").slice(-3).join(" | ").slice(0, 300)}` };
      if (wall > TIME_LIMIT) r.problems.push(`took ${Math.round(wall / 1000)} s (limit ${TIME_LIMIT / 1000} s)`);
      if (r.maxRssMB > RSS_LIMIT) r.problems.push(`used ${r.maxRssMB} MB of memory (limit ${RSS_LIMIT} MB)`);
      r.key = key([tool, fixture, variant]);
      r.wall = wall;
      resolve(r);
    });
  });
}

const heavy = new Set(["bomb-orphan.pdf", "bomb-image.pdf", "huge-page.pdf", "pages-1500.pdf", "huge-scan.pdf"]);
const light = todo.filter(([, f]) => !heavy.has(f));
const results = [];
const failing = (r) => r.crash || !r.ok || r.problems.length;
// What went wrong, one part each: the crash or the error, then every problem.
const parts = (r) => [...(r.crash ? [`crash: ${r.crash}`] : !r.ok ? [`error: ${r.error?.message ?? ""}`] : []), ...r.problems];
const describe = (r) => parts(r).map((p) => p.slice(0, 160)).join("; ").slice(0, 400);
// A listed case fails as listed when every part contains one of its "fails"
// texts; a crash or a kill only ever matches a text that starts with "crash: ".
const asListed = (r) => parts(r).every((p) => known[r.key].fails.some((f) => p.includes(f) && p.startsWith("crash: ") === f.startsWith("crash: ")));
const report = (r) => {
  results.push(r);
  if (failing(r)) console.log(`FAIL  ${r.key.padEnd(40)} ${describe(r)}${known[r.key] ? `  [${asListed(r) ? "known" : "listed as failing another way"}: ${known[r.key].why}]` : ""}`);
  if (results.length % 100 === 0) console.log(`      ${results.length}/${todo.length} cases run`);
};

console.log(`${todo.length} cases, ${concurrency} at a time${process.env.ROBUST_KEEP ? `; outputs in ${out}` : ""}`);
let next = 0;
await Promise.all(Array.from({ length: concurrency }, async () => {
  while (next < light.length) report(await run(light[next++]));
}));
// Memory-hungry cases one at a time, so they don't starve each other.
for (const c of todo.filter(([, f]) => heavy.has(f))) report(await run(c));

const failed = results.filter(failing);
const unexpected = failed.filter((r) => !known[r.key] || !asListed(r));
const fixed = results.filter((r) => known[r.key] && !failing(r));
console.log(`\n${results.length - failed.length}/${results.length} cases pass; ${failed.length} fail (${failed.length - unexpected.length} known, ${unexpected.length} new)`);
for (const r of unexpected) console.log(`  new failure: ${r.key}  ${describe(r)}${known[r.key] ? `  (listed as failing with ${JSON.stringify(known[r.key].fails)})` : ""}`);
for (const r of fixed) console.log(`  now passes: ${r.key}  (listed for ${known[r.key].why})`);

if (flag("--prune") && fixed.length) {
  for (const r of fixed) delete known[r.key];
  // One case per line, sorted, so a fix shows up as removed lines.
  writeFileSync(knownPath, `{\n${Object.keys(known).sort((a, b) => a.localeCompare(b)).map((k) => `  ${JSON.stringify(k)}: ${JSON.stringify(known[k])}`).join(",\n")}\n}\n`);
  console.log(`  removed ${fixed.length} from known-failures.json`);
}
if (flag("--known")) process.exit(unexpected.length || (fixed.length && !flag("--prune")) ? 1 : 0);
process.exit(failed.length ? 1 : 0);
