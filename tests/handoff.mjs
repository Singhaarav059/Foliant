// Handing files to a tool (src/lib/handoff.ts): which tools a set of files
// can go to, when a stashed hand-over is still good, and that the service
// worker (public/sw.js) writes the shared files where the page reads them.
//
//   node tests/handoff.mjs
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const out = mkdtempSync(join(tmpdir(), "handoff-"));
execFileSync(join(root, "node_modules/.bin/tsc"), [
  "--outDir", out, "--module", "commonjs", "--target", "es2022", "--moduleResolution", "node10",
  "--skipLibCheck", "--noCheck", "--rootDir", "src/lib", "src/lib/handoff.ts",
], { cwd: root, stdio: "inherit" });
writeFileSync(join(out, "package.json"), '{"type":"commonjs"}');
const { INBOX, STASH_MS, fromStored, toStored, toolsFor, usable } = createRequire(import.meta.url)(join(out, "handoff.js"));

let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`ok    ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL  ${name}: ${e.message}`);
  }
}
function eq(a, b, what) {
  if (a !== b) throw new Error(`${what}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}
const file = (name, type = "") => ({ name, type });
const ids = (files) => toolsFor(files).map((t) => t.id);

await test("one PDF can go to every PDF tool that takes a file", () => {
  const got = ids([file("report.pdf", "application/pdf")]);
  for (const id of ["merge", "split", "compress", "rotate", "sign", "pdfToWord", "protect"]) {
    if (!got.includes(id)) throw new Error(`${id} missing from ${got.join(", ")}`);
  }
  for (const id of ["jpgToPdf", "wordToPdf", "scan", "htmlToPdf"]) if (got.includes(id)) throw new Error(`offers ${id}`);
});

await test("several PDFs only go to tools that take several files", () => {
  const got = ids([file("a.pdf"), file("b.PDF")]);
  if (!got.includes("merge") || !got.includes("compress")) throw new Error(got.join(", "));
  // Redact takes a batch since P2-03.
  for (const id of ["split", "sign"]) if (got.includes(id)) throw new Error(`offers ${id}`);
});

// The exam photo kit takes photos too.
await test("photos go to the exam photo kit and JPG to PDF, by extension or by type", () => {
  eq(ids([file("IMG_1.HEIC")]).join(), "examKit,jpgToPdf", "heic");
  eq(ids([file("shared", "image/jpeg"), file("b.png")]).join(), "examKit,jpgToPdf", "image without an extension");
});

await test("a Word file goes to Word to PDF", () => eq(ids([file("brief.docx")]).join(), "wordToPdf", "docx"));

await test("mixed files go only to PDF attachments; unknown ones nowhere", () => {
  eq(ids([file("a.pdf"), file("b.docx")]).join(), "attachments", "pdf + docx: attach the Word file");
  eq(ids([file("notes.txt", "text/plain")]).length, 0, "txt alone");
  eq(ids([]).length, 0, "nothing");
});

await test("a stashed file comes back with its name, type and bytes", async () => {
  const stored = await toStored(new File(["%PDF-1.7"], "a.pdf", { type: "application/pdf", lastModified: 42 }));
  if (!(stored.data instanceof ArrayBuffer)) throw new Error("not kept as bytes");
  const back = fromStored(stored);
  eq(back.name, "a.pdf", "name");
  eq(back.type, "application/pdf", "type");
  eq(back.lastModified, 42, "lastModified");
  eq(await back.text(), "%PDF-1.7", "bytes");
});

await test("a stashed hand-over is used once, by its tool, while fresh", async () => {
  const files = [await toStored(new File(["x"], "a.pdf"))];
  const now = 1_000_000;
  eq(usable({ files, at: now, tool: "compress" }, "compress", now + 1000)?.[0].name, "a.pdf", "fresh, same tool");
  eq(usable({ files, at: now, tool: "compress" }, "merge", now + 1000), null, "another tool");
  eq(usable({ files, at: now, tool: "compress" }, "compress", now + STASH_MS + 1), null, "stale");
  eq(usable({ files, at: now }, undefined, now)?.length, 1, "shared files, no tool");
  eq(usable(undefined, "compress", now), null, "nothing stashed");
  eq(usable({ files: [], at: now, tool: "compress" }, "compress", now), null, "empty");
});

await test("the service worker writes the inbox the page reads", () => {
  const sw = readFileSync(join(root, "public/sw.js"), "utf8");
  const m = sw.match(/const INBOX = (\{[^}]+\});/);
  if (!m) throw new Error("public/sw.js has no INBOX constant");
  const inSw = Function(`return ${m[1]}`)();
  eq(inSw.db, INBOX.db, "database");
  eq(inSw.store, INBOX.store, "store");
  eq(inSw.shared, INBOX.shared, "key");
  const manifest = JSON.parse(readFileSync(join(root, "public/manifest.webmanifest"), "utf8"));
  eq(manifest.share_target?.action, "/share", "share_target action");
  if (!sw.includes(`"${manifest.share_target.action}"`)) throw new Error("sw.js doesn't handle the share_target action");
  eq(manifest.share_target.params.files[0].name, "files", "file field");
  // The same record shape as toStored.
  for (const field of ["name", "type", "lastModified", "data"]) if (!new RegExp(`\\b${field}:`).test(sw)) throw new Error(`sw.js doesn't store ${field}`);
});

console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
