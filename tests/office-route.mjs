// Office → PDF in the static build: which way a job goes for each fidelity,
// file type and device (src/lib/office/route.ts). The browser run of the
// whole flow is tests/e2e-office.mjs.
//
//   node tests/office-route.mjs
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { root, check, eq } from "./lib/load.mjs";

const out = mkdtempSync(join(tmpdir(), "office-route-"));
execFileSync(join(root, "node_modules/.bin/tsc"), ["--outDir", out, "--module", "esnext", "--target", "es2022", "--moduleResolution", "bundler", "--skipLibCheck", "--noCheck", "--rootDir", "src/lib", "src/lib/office/route.ts"], { cwd: root, stdio: "inherit" });
const { officeRoute } = await import(pathToFileURL(join(out, "office/route.js")).href);
const results = { failed: 0 };
const test = check(results);

const desktop = { isolated: false, worker: true, reloaded: false, phone: false, webkit: false, memory: 8 };
const route = (fidelity, names, env = {}) => officeRoute(fidelity, names, { ...desktop, ...env });

await test("automatic makes a real PDF on a computer", () => {
  eq(route("auto", ["brief.docx"], { isolated: true }), "libreoffice", "isolated page");
  eq(route("auto", ["brief.docx"]), "reload", "first visit, service worker active");
  eq(route("auto", ["brief.docx"], { memory: undefined, isolated: true }), "libreoffice", "browser that doesn't tell its memory");
});

await test("automatic prints on phones and small devices", () => {
  eq(route("auto", ["plan.pptx"], { phone: true, isolated: true }), "print", "phone");
  eq(route("auto", ["budget.xlsx"], { memory: 2, isolated: true }), "print", "2 GB");
  eq(route("auto", ["budget.xlsx"], { memory: 4, isolated: true }), "libreoffice", "4 GB is enough");
});

// LibreOffice doesn't start in WebKit yet: Automatic doesn't wait on it there.
await test("automatic prints in Safari, high still tries LibreOffice", () => {
  eq(route("auto", ["brief.docx"], { webkit: true, isolated: true }), "print", "automatic");
  eq(route("high", ["brief.docx"], { webkit: true, isolated: true }), "libreoffice", "high");
  eq(route("auto", ["old.doc"], { webkit: true, isolated: true }), "libreoffice", "a .doc");
});

await test("automatic prints where LibreOffice can't run", () => {
  eq(route("auto", ["brief.docx"], { worker: false }), "print", "no service worker");
  eq(route("auto", ["brief.docx"], { reloaded: true }), "print", "reloaded and still not isolated");
});

await test("standard always prints the formats it can read", () => {
  eq(route("standard", ["brief.docx", "budget.csv"], { isolated: true }), "print", "standard");
});

await test("high and old formats need LibreOffice, on any device", () => {
  eq(route("high", ["brief.docx"]), "reload", "high, first visit");
  eq(route("standard", ["old.doc"], { phone: true, isolated: true }), "libreoffice", "a .doc on a phone");
  eq(route("auto", ["slides.odp"], { worker: false }), "unavailable", ".odp without isolation");
  eq(route("high", ["brief.docx"], { reloaded: true }), "unavailable", "high, reload didn't help");
});

process.exit(results.failed ? 1 : 0);
