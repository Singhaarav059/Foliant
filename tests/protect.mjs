// Protect tests: every password a person can type gives a file that opens
// with exactly that password, and one the encryption can't hold is refused
// before anything is made, instead of producing a file nobody can open.
//
//   node tests/protect.mjs
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { load, root, check, eq } from "./lib/load.mjs";
import { corpus } from "./lib/corpus.mjs";

const { protect, unlock } = await load("security");
const results = { failed: 0 };
const test = check(results);
const input = readFileSync(join(root, "tests/fixtures/report.pdf"));
const file = (bytes = input, name = "report.pdf") => new File([bytes], name, { type: "application/pdf" });
const options = { allowPrint: true, allowCopy: true, allowModify: true };

const openPdf = (bytes, password) => getDocument({ data: new Uint8Array(bytes), password, verbosity: 0 }).promise;
// Protect checks its output with pdf.js; the first document opened here starts
// pdf.js's in-process worker, which Node needs instead of the site's /vendor file.
await (await openPdf(input)).loadingTask.destroy();

// Opens with pdf.js: the page count, or the error's name.
async function opens(bytes, password) {
  try {
    const pdf = await openPdf(bytes, password);
    const n = pdf.numPages;
    await pdf.loadingTask.destroy();
    return n;
  } catch (e) {
    return e.name;
  }
}
const protectedWith = async (password, o = options) => {
  const [out] = await protect(file(), { password, ...o });
  return new Uint8Array(await out.blob.arrayBuffer());
};

// Passwords that look like qpdf options or response files ("@file").
for (const password of ["-v", "--", "@notes", "@Secure2024", "@/in.pdf", "--help", "-", " spaced out ", "pässwörd-日本語-🔒", "a".repeat(127)]) {
  await test(`password ${JSON.stringify(password.length > 20 ? `${password.slice(0, 8)}…(${password.length})` : password)} opens the file, and only it does`, async () => {
    const bytes = await protectedWith(password);
    eq(await opens(bytes, password), 3, "pages with the password");
    eq(await opens(bytes), "PasswordException", "without a password");
    // pdf.js reads only the first 127 bytes, so the wrong one differs at the start.
    eq(await opens(bytes, "x" + password), "PasswordException", "with a wrong password");
  });
}

for (const [label, password] of [["200 × a", "a".repeat(200)], ["128 bytes of é", "é".repeat(64)], ["128 bytes, mixed", "a".repeat(125) + "日"]]) {
  await test(`a password over 127 bytes (${label}) is refused before encrypting`, async () => {
    let error;
    try {
      await protectedWith(password);
    } catch (e) {
      error = e;
    }
    eq(error?.code, "password_too_long", "error code");
    // How many characters would fit, for the message.
    eq(error.max, [...password].findIndex((_, i, all) => new TextEncoder().encode(all.slice(0, i + 1).join("")).length > 127), "characters that fit");
  });
}

await test("permissions are still applied", async () => {
  const bytes = await protectedWith("perm-test", { allowPrint: false, allowCopy: false, allowModify: false });
  const pdf = await openPdf(bytes, "perm-test");
  const perms = await pdf.getPermissions();
  await pdf.loadingTask.destroy();
  // pdf.js lists what is allowed: printing (4), changing (8) and copying (16) must not be.
  eq(Boolean(perms && !perms.has(4) && !perms.has(8) && !perms.has(16)), true, `permissions ${JSON.stringify(perms && [...perms])}`);
});

await test("AES-256 encryption", async () => {
  const bytes = await protectedWith("aes");
  const text = Buffer.from(bytes).toString("latin1");
  eq(/\/V 5\b/.test(text) && /\/R 6\b/.test(text), true, "/V 5 /R 6 in the encryption dictionary");
});

await test("Unlock opens what Protect made, with an option-like password", async () => {
  const bytes = await protectedWith("@Secure2024");
  const [out] = await unlock(file(bytes, "locked.pdf"), { password: "@Secure2024" });
  eq(await opens(await out.blob.arrayBuffer()), 3, "unlocked pages without a password");
});

// Damaged files every reader opens (P1-03): qpdf alone gives up on them.
const fx = corpus(["garbage-prefix.pdf", "deep-tree.pdf", "truncated-tail.pdf", "startxref-garbage.pdf"]);
for (const [name, pages] of [["garbage-prefix.pdf", 3], ["deep-tree.pdf", 1], ["truncated-tail.pdf", 3], ["startxref-garbage.pdf", 3]]) {
  await test(`Protect and Unlock take ${name}, a damaged file readers open`, async () => {
    const [out] = await protect(file(fx[name], name), { password: "pw", ...options });
    const bytes = new Uint8Array(await out.blob.arrayBuffer());
    eq(await opens(bytes), "PasswordException", "without a password");
    eq(await opens(bytes, "pw"), pages, "pages with the password");
    // The same damage on a protected file.
    const junk = new Uint8Array([...new TextEncoder().encode("JUNK ".repeat(300)), ...bytes]);
    const [open] = await unlock(file(junk, "locked.pdf"), { password: "pw" });
    eq(await opens(await open.blob.arrayBuffer()), pages, "unlocked pages without a password");
  });
}

// ── Permissions (P1-12): seven restrictions, an owner password of one's own,
// restrictions without an open password, AES-256 by default.
const { qpdfReport } = await load("qpdf");
const pw = await load("password");
const all = { allowPrint: true, allowPrintHigh: true, allowCopy: true, allowModify: true, allowAnnotate: true, allowForms: true, allowAssemble: true };
const report = (bytes, password = "") => qpdfReport(new Uint8Array(bytes), (i) => ["--show-encryption", `--password=${password}`, i]);
const permsOf = async (bytes, password) => {
  const pdf = await openPdf(bytes, password);
  const perms = await pdf.getPermissions();
  await pdf.loadingTask.destroy();
  return perms && [...perms];
};

await test("printing off with no open password: opens without one, printing disabled", async () => {
  const bytes = await protectedWith("", { ...all, allowPrint: false });
  eq(await opens(bytes), 3, "pages without a password");
  const perms = await permsOf(bytes);
  // pdf.js lists what's allowed: print (4) and high-quality print (2048) must not be.
  eq(Boolean(perms && !perms.includes(4) && !perms.includes(2048) && perms.includes(16)), true, `permissions ${JSON.stringify(perms)}`);
});

const FLAGS = {
  allowPrint: ["print low resolution", "print high resolution"],
  allowPrintHigh: ["print high resolution"],
  allowCopy: ["extract for any purpose"],
  allowModify: ["modify other"],
  allowAnnotate: ["modify annotations"],
  allowForms: ["modify forms"],
  allowAssemble: ["modify document assembly"],
};
for (const [flag, lines] of Object.entries(FLAGS)) {
  await test(`AES-256 (R = 6) and ${flag} off denies exactly that`, async () => {
    const bytes = await protectedWith("open", { ...all, [flag]: false });
    const text = await report(bytes, "open");
    eq(/^R = 6$/m.test(text), true, "R = 6");
    eq(/file encryption method: AESv3/.test(text), true, "AES-256");
    for (const line of ["print low resolution", "print high resolution", "extract for any purpose", "modify other", "modify annotations", "modify forms", "modify document assembly"]) {
      eq(new RegExp(`^${line}: ${lines.includes(line) ? "not allowed" : "allowed"}$`, "m").test(text), true, `${line} (${text.replace(/\n/g, "; ")})`);
    }
  });
}

await test("an owner password of one's own opens the file as its owner", async () => {
  const bytes = await protectedWith("reader", { ...all, allowCopy: false, ownerPassword: "boss-pw" });
  eq(await opens(bytes, "boss-pw"), 3, "pages with the owner password");
  eq(/Supplied password is owner password/.test(await report(bytes, "boss-pw")), true, "owner password");
  eq(/Supplied password is user password/.test(await report(bytes, "reader")), true, "open password");
});

await test("AES-128 for older readers", async () => {
  const bytes = await protectedWith("old", { ...all, encryption: "aes128" });
  const text = await report(bytes, "old");
  eq(/^R = 4$/m.test(text) && /file encryption method: AESv2/.test(text), true, text.replace(/\n/g, "; "));
  eq(await opens(bytes, "old"), 3, "pages with the password");
});

await test("the form's checks: an open password, or at least one restriction", async () => {
  const check = (o) => pw.protectProblem({ password: "", confirmPassword: "", ownerPassword: "", ...all, ...o });
  eq(check({})?.code, "passwordEmpty", "no password");
  eq(check({ allowPrint: false })?.code, "passwordEmpty", "a password is asked for unless turned off");
  eq(check({ openPassword: false })?.code, "noRestriction", "nothing to protect");
  eq(check({ openPassword: false, allowPrint: false, password: "x" }), null, "restrictions only (a typed password is ignored)");
  eq(check({ password: "a", confirmPassword: "b" })?.code, "passwordMismatch", "mismatch");
  eq(check({ password: "a", confirmPassword: "a" }), null, "a password");
  eq(check({ openPassword: false, allowCopy: false, ownerPassword: "é".repeat(64) })?.code, "passwordTooLong", "owner password too long");
});

await test("suggested passwords are random and rated strong; short ones weak", async () => {
  const a = pw.suggestPassword(), b = pw.suggestPassword();
  eq(a !== b && a.length >= 20, true, `${a} / ${b}`);
  eq(pw.passwordStrength(a), 4, "suggested");
  eq(pw.passwordStrength(""), 0, "empty");
  eq(pw.passwordStrength("abc") <= 1, true, "abc");
  eq(pw.passwordStrength("password123") <= 1, true, "a common password");
  eq(pw.passwordStrength("Tr0ub4dor&3x") >= 2, true, "mixed");
});

process.exit(results.failed ? 1 : 0);
