// Certificate signing and the signature checker in real browsers: a .p12
// opens with its password (and a wrong one is refused), Sign PDF writes a
// signature that the checker and `openssl cms -verify` accept, with or
// without a drawn signature, and Check PDF signatures reports valid, changed
// and unsigned files. Nothing is sent to another site, and neither the
// password nor the certificate is left in the browser's storage.
//
//   node tests/e2e/pades.mjs [chromium] [firefox] [webkit]   (see kit.mjs)
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { base, dict, open, pick, suite } from "./kit.mjs";
import { load } from "../lib/load.mjs";

const { checkSignatures } = await load("sign");
const t = dict("en");
const dir = mkdtempSync(join(tmpdir(), "e2e-pades-"));
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
const pw = randomBytes(12).toString("hex");
const env = { ...process.env, NOPLOAD_P12: pw };
const openssl = (...args) => execFileSync("openssl", args, { cwd: dir, env, stdio: ["ignore", "pipe", "pipe"] });
openssl("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "k.pem", "-out", "c.pem", "-subj", "/CN=Nopload E2E Signer/O=Nopload Tests", "-days", "30");
openssl("pkcs12", "-export", "-inkey", "k.pem", "-in", "c.pem", "-out", "test.p12", "-passout", "env:NOPLOAD_P12");
const p12 = join(dir, "test.p12");

// openssl's verdict on a signature over its byte range.
function opensslVerifies(bytes, r) {
  const [, b, c, d] = r.bytes;
  const blob = Buffer.from(Buffer.from(bytes.subarray(b + 1, c - 1)).toString("latin1"), "hex");
  const n = blob.subarray(2, 2 + (blob[1] & 0x7f)).reduce((s, x) => s * 256 + x, 0) + 2 + (blob[1] & 0x7f);
  writeFileSync(join(dir, "sig.der"), blob.subarray(0, n));
  writeFileSync(join(dir, "data.bin"), Buffer.concat([bytes.subarray(0, b), bytes.subarray(c, c + d)]));
  return spawnSync("openssl", ["cms", "-verify", "-binary", "-inform", "DER", "-in", "sig.der", "-content", "data.bin", "-noverify", "-out", "/dev/null"], { cwd: dir }).status === 0;
}

await suite(async ({ name, browser, test }) => {
  const ctx = await browser.newContext({ acceptDownloads: true, locale: "en-US", viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  page.setDefaultTimeout(20000);
  // Every request must stay on this site.
  const away = [];
  const origin = new URL(base).origin;
  page.on("request", (r) => {
    const u = r.url();
    if (/^https?:/.test(u) && new URL(u).origin !== origin) away.push(u);
  });

  const loadSign = async () => {
    await open(page, "/en/sign-pdf");
    await pick(page, ["report.pdf"]);
    await page.waitForFunction(() => [...document.querySelectorAll("main img")].some((i) => i.src.startsWith("blob:") && i.naturalWidth > 0), null, { timeout: 30000 });
  };
  const useCertificate = async (password) => {
    const panel = page.locator("details").filter({ has: page.getByText(t["cert.title"], { exact: true }) });
    if (!(await panel.evaluate((d) => d.open))) await panel.locator("summary").click();
    await page.locator('input[type=file][accept*=".p12"]').setInputFiles(p12);
    await page.getByLabel(t["cert.password"]).fill(password);
    await page.getByRole("button", { name: t["cert.open"] }).click();
  };
  const save = async () => {
    const button = page.getByRole("button", { name: t["tool.sign.action"], exact: true }).locator("visible=true").first();
    const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 60000 }), button.click()]);
    const path = join(dir, `${name}-${Date.now()}-${dl.suggestedFilename()}`);
    await dl.saveAs(path);
    return path;
  };

  let signedPath;
  await test("a wrong password is refused, the right one opens the certificate", async () => {
    await loadSign();
    await useCertificate(pw + "x");
    await page.getByRole("alert").filter({ hasText: t["cert.err.wrong_password"] }).waitFor();
    await page.getByLabel(t["cert.password"]).fill(pw);
    await page.getByRole("button", { name: t["cert.open"] }).click();
    await page.getByText(t["cert.signingAs"].replace("{name}", "Nopload E2E Signer")).waitFor();
    // The password field is gone with the file; only the opened key is held.
    if (await page.getByLabel(t["cert.password"]).count()) throw new Error("password field still shown");
  });

  await test("signing with only a certificate gives a valid PAdES signature", async () => {
    await page.getByLabel(t["cert.reason"]).fill("Approved in the browser");
    signedPath = await save();
    const bytes = new Uint8Array(readFileSync(signedPath));
    const [r, ...rest] = await checkSignatures(bytes);
    if (rest.length) throw new Error(`${rest.length + 1} signatures`);
    if (r.status !== "valid" || !r.pades || !r.wholeFile) throw new Error(`status ${r.status}, pades ${r.pades}, whole ${r.wholeFile}`);
    if (r.signer?.name !== "Nopload E2E Signer" || r.reason !== "Approved in the browser") throw new Error(`signer ${r.signer?.name}, reason ${r.reason}`);
    if (!opensslVerifies(bytes, r)) throw new Error("openssl cms -verify failed");
    // The original file's bytes are the start of the signed one.
    const original = readFileSync(join(import.meta.dirname, "../fixtures/report.pdf"));
    if (!Buffer.from(bytes.subarray(0, original.length)).equals(original)) throw new Error("original bytes not kept");
  });

  await test("a typed signature and a certificate together", async () => {
    await loadSign();
    await page.getByRole("button", { name: t["ed.signature"], exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("tab", { name: t["ed.typeTab"] }).click();
    await dialog.getByPlaceholder(t["ed.typeName"]).fill("Ada Lovelace");
    await dialog.getByRole("button", { name: t["ed.useSignature"] }).click();
    await page.getByRole("button", { name: t["ed.placeCentre"] }).click();
    await useCertificate(pw);
    await page.getByText(t["cert.signingAs"].replace("{name}", "Nopload E2E Signer")).waitFor();
    const bytes = new Uint8Array(readFileSync(await save()));
    const [r] = await checkSignatures(bytes);
    if (r?.status !== "valid" || !r.wholeFile) throw new Error(`status ${r?.status}`);
    if (!opensslVerifies(bytes, r)) throw new Error("openssl cms -verify failed");
    if (!/\/Subtype\s*\/Image/.test(Buffer.from(bytes).toString("latin1"))) throw new Error("typed signature image missing");
  });

  await test("nothing about the certificate is stored", async () => {
    const stored = await page.evaluate(async () => ({
      keys: [...Object.keys(localStorage), ...Object.keys(sessionStorage), ...((await indexedDB.databases?.().catch(() => [])) ?? []).map((d) => d.name)],
      values: JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }),
    }));
    if (stored.values.includes(pw)) throw new Error("password found in storage");
    // The certificate's own bytes, base64 as storage would hold them, or its subject.
    const der = Buffer.from(readFileSync(join(dir, "c.pem"), "utf8").replace(/-----[^-]+-----|\s/g, ""), "base64");
    const p12b64 = readFileSync(p12).toString("base64").slice(0, 64);
    if (stored.values.includes("Nopload E2E Signer") || stored.values.includes(der.toString("base64").slice(0, 64)) || stored.values.includes(p12b64)) {
      throw new Error("certificate found in storage");
    }
    const odd = stored.keys.filter((k) => /p12|pfx|cert|sign-key|private/i.test(k));
    if (odd.length) throw new Error(`storage keys: ${odd.join(", ")}`);
    return stored.keys.join(", ");
  });

  const check = async (file) => {
    await open(page, "/en/verify-pdf-signature");
    await pick(page, [file]);
  };
  await test("the checker says a signed file is valid, with its signer", async () => {
    await check(signedPath);
    const card = page.locator("article").first();
    await card.getByRole("heading", { name: t["check.status.valid"] }).waitFor();
    await card.getByText("Nopload E2E Signer").first().waitFor();
    await card.getByText(t["check.wholeFile"]).waitFor();
  });

  await test("one changed byte: the checker says the content was changed", async () => {
    const bytes = readFileSync(signedPath);
    bytes[7] = bytes[7] === 0x31 ? 0x32 : 0x31;
    const path = join(dir, `${name}-tampered.pdf`);
    writeFileSync(path, bytes);
    await check(path);
    await page.getByRole("heading", { name: t["check.status.modified"] }).waitFor();
  });

  await test("a change saved after signing is reported", async () => {
    const bytes = readFileSync(signedPath);
    const s = bytes.toString("latin1");
    const prev = +/startxref\s+(\d+)/.exec(s.slice(s.lastIndexOf("startxref")))[1];
    const size = Math.max(...[...s.matchAll(/\/Size\s+(\d+)/g)].map((m) => +m[1]));
    const rootRef = /\/Root\s+(\d+ \d+ R)/.exec(s.slice(s.lastIndexOf("/Root")))[1];
    const body = `${size} 0 obj\n<< /Title (Changed later) >>\nendobj\n`;
    const xrefAt = bytes.length + body.length;
    const tail = `xref\n${size} 1\n${String(bytes.length).padStart(10, "0")} 00000 n\r\ntrailer\n<< /Size ${size + 1} /Root ${rootRef} /Info ${size} 0 R /Prev ${prev} >>\nstartxref\n${xrefAt}\n%%EOF\n`;
    const path = join(dir, `${name}-updated.pdf`);
    writeFileSync(path, Buffer.concat([bytes, Buffer.from(body + tail, "latin1")]));
    await check(path);
    await page.getByRole("heading", { name: t["check.status.valid"] }).waitFor();
    await page.getByText(t["check.changedAfter"]).waitFor();
  });

  await test("an unsigned file has no signatures", async () => {
    await check("report.pdf");
    await page.getByText(t["check.none"]).waitFor();
  });

  await test("no request left the site", async () => {
    if (away.length) throw new Error(`requests to ${[...new Set(away.map((u) => new URL(u).origin))].join(", ")}`);
  });

  await ctx.close();
});
