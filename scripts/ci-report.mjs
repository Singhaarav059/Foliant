// Runs a test command and, when it fails on GitHub Actions, repeats the end of
// its output as an error annotation. Annotations are public on the run page
// and through the API, where the logs themselves need a sign-in, so a failure
// on the Linux runners can be read (and fixed) without one.
//
//   node scripts/ci-report.mjs "<title>" <command> [args...]
//
// The output streams through unchanged and the exit code is the command's.
// CI_REPORT_LINES (40) sets how many trailing lines the annotation keeps.
import { spawn } from "node:child_process";

const [title, cmd, ...args] = process.argv.slice(2);
if (!title || !cmd) {
  console.error('usage: node scripts/ci-report.mjs "<title>" <command> [args...]');
  process.exit(2);
}
const keep = Number(process.env.CI_REPORT_LINES ?? 40);

// Workflow-command escaping (as in @actions/core): data escapes % CR LF,
// properties also , and :.
const escapeData = (s) => s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
const escapeProperty = (s) => escapeData(s).replace(/:/g, "%3A").replace(/,/g, "%2C");
// Colours and cursor codes would show up as junk in the annotation.
const plain = (s) => s.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");

let tail = [];
let partial = "";
const collect = (chunk) => {
  const lines = (partial + chunk.toString()).split("\n");
  partial = lines.pop();
  tail.push(...lines.map(plain));
  if (tail.length > keep * 4) tail = tail.slice(-keep);
};

const child = spawn(cmd, args, { stdio: ["inherit", "pipe", "pipe"], shell: process.platform === "win32" });
child.stdout.on("data", (d) => { process.stdout.write(d); collect(d); });
child.stderr.on("data", (d) => { process.stderr.write(d); collect(d); });
child.on("error", (e) => { tail.push(`could not start ${cmd}: ${e.message}`); });
child.on("close", (code, signal) => {
  if (partial) tail.push(plain(partial));
  const failed = code !== 0;
  if (failed && process.env.GITHUB_ACTIONS) {
    const lines = tail.filter((l) => l.trim()).slice(-keep);
    lines.push(signal ? `(killed by ${signal})` : `(exit code ${code})`);
    // One annotation for the whole tail: a step keeps at most 10 error annotations.
    process.stdout.write(`::error title=${escapeProperty(title)}::${escapeData(lines.join("\n"))}\n`);
  }
  process.exit(code ?? 1);
});
