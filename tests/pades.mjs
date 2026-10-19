// Certificate signing (PAdES B-B) and the signature checker. Test
// certificates are made here with openssl and thrown away afterwards; their
// password is random and never printed. Every signature is also checked by
// an independent verifier, `openssl cms -verify`, over the byte range, and
// the whole file by poppler's pdfsig when it's installed (PDFSIG sets its path).
//
//   node tests/pades.mjs          (OPENSSL sets the openssl binary)
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PDFDocument, PDFName, PDFString, StandardFonts } from "pdf-lib";
import forge from "node-forge";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { load, root, check, eq } from "./lib/load.mjs";

const { signPdf, checkSignatures } = await load("sign");
const { openCertificate } = await load("p12");
const { runQpdf } = await load("qpdf");
const results = { failed: 0 };
const test = check(results);

const dir = mkdtempSync(join(tmpdir(), "pades-"));
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
const pw = randomBytes(12).toString("hex");
const OPENSSL = process.env.OPENSSL ?? "openssl";
const env = { ...process.env, NOPLOAD_P12: pw };
const at = (f) => join(dir, f);
const openssl = (...args) => {
  try {
    return execFileSync(OPENSSL, args, { cwd: dir, env, stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    throw new Error(`openssl ${args[0]}: ${String(e.stderr).trim()}`);
  }
};
const ok = (...args) => spawnSync(OPENSSL, args, { cwd: dir, env, encoding: "utf8" });

// ── Test certificates
const subj = (cn) => `/CN=${cn}/O=Nopload Tests`;
openssl("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "rsa.key", "-out", "rsa.pem", "-subj", subj("Nopload Test Signer"), "-days", "30");
// Legacy 3DES with a SHA-1 MAC, as macOS and Windows export, spelled out so
// OpenSSL 3 (AES by default) writes the same kind of file as LibreSSL.
const legacy = ["-keypbe", "PBE-SHA1-3DES", "-certpbe", "PBE-SHA1-3DES", "-macalg", "sha1"];
openssl("pkcs12", "-export", ...legacy, "-inkey", "rsa.key", "-in", "rsa.pem", "-out", "rsa.p12", "-passout", "env:NOPLOAD_P12");
// AES-256 with a SHA-256 MAC, OpenSSL 3's default.
openssl("pkcs12", "-export", "-keypbe", "AES-256-CBC", "-certpbe", "AES-256-CBC", "-macalg", "sha256", "-inkey", "rsa.key", "-in", "rsa.pem", "-out", "aes-openssl.p12", "-passout", "env:NOPLOAD_P12");
openssl("ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", "ec.key");
openssl("req", "-new", "-x509", "-key", "ec.key", "-out", "ec.pem", "-subj", subj("Nopload EC Signer"), "-days", "30");
openssl("pkcs12", "-export", "-inkey", "ec.key", "-in", "ec.pem", "-out", "ec.p12", "-passout", "env:NOPLOAD_P12");
// A CA and a certificate it issued, in one file.
writeFileSync(at("ca.ext"), "basicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\n");
writeFileSync(at("leaf.ext"), "basicConstraints=CA:FALSE\nkeyUsage=critical,digitalSignature,nonRepudiation\n");
openssl("req", "-newkey", "rsa:2048", "-nodes", "-keyout", "ca.key", "-out", "ca.csr", "-subj", subj("Nopload Test CA"));
openssl("x509", "-req", "-in", "ca.csr", "-signkey", "ca.key", "-out", "ca.pem", "-days", "30", "-extfile", "ca.ext");
openssl("req", "-newkey", "rsa:2048", "-nodes", "-keyout", "leaf.key", "-out", "leaf.csr", "-subj", subj("Nopload Leaf Signer"));
openssl("x509", "-req", "-in", "leaf.csr", "-CA", "ca.pem", "-CAkey", "ca.key", "-set_serial", "4242", "-out", "leaf.pem", "-days", "30", "-extfile", "leaf.ext");
openssl("pkcs12", "-export", "-inkey", "leaf.key", "-in", "leaf.pem", "-certfile", "ca.pem", "-out", "chain.p12", "-passout", "env:NOPLOAD_P12");
openssl("pkcs12", "-export", "-nokeys", "-in", "rsa.pem", "-out", "nokey.p12", "-passout", "env:NOPLOAD_P12");
// The same RSA key in an AES-256 (PBES2) file, as OpenSSL 3 writes by default.
{
  const key = forge.pki.privateKeyFromPem(readFileSync(at("rsa.key"), "utf8"));
  const cert = forge.pki.certificateFromPem(readFileSync(at("rsa.pem"), "utf8"));
  const asn1 = forge.pkcs12.toPkcs12Asn1(key, [cert], pw, { algorithm: "aes256" });
  writeFileSync(at("aes.p12"), Buffer.from(forge.asn1.toDer(asn1).getBytes(), "binary"));
}
const p12 = (f) => new Uint8Array(readFileSync(at(f)));

// ── Documents
const report = new Uint8Array(readFileSync(join(root, "tests/fixtures/report.pdf")));
async function made(useObjectStreams) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= 2; i++) doc.addPage([400, 300]).drawText(`Page ${i}`, { x: 50, y: 150, size: 24, font });
  return new Uint8Array(await doc.save({ useObjectStreams }));
}
// qpdf reads the file through its cross-reference sections and warns when it has to rebuild them.
const qpdfWarnings = async (bytes) => (await runQpdf(bytes, (i, o) => [i, o])).warnings.join(" | ");
const pages = async (bytes) => {
  const pdf = await getDocument({ data: bytes.slice(), verbosity: 0 }).promise;
  const n = pdf.numPages;
  await pdf.loadingTask.destroy();
  return n;
};

// The CMS blob and the signed bytes of a signature, as files for openssl.
let seq = 0;
function extract(bytes, r) {
  const [, b, c, d] = r.bytes;
  const blob = Buffer.from(Buffer.from(bytes.subarray(b + 1, c - 1)).toString("latin1"), "hex");
  // The DER length (0x30 0x82 hi lo or 0x30 0x83 …), so the zero padding is left out.
  const n = blob[1] & 0x80 ? blob.subarray(2, 2 + (blob[1] & 0x7f)).reduce((s, x) => s * 256 + x, 0) + 2 + (blob[1] & 0x7f) : blob[1] + 2;
  const id = ++seq;
  writeFileSync(at(`sig${id}.der`), blob.subarray(0, n));
  writeFileSync(at(`data${id}.bin`), Buffer.concat([bytes.subarray(0, b), bytes.subarray(c, c + d)]));
  return { sig: `sig${id}.der`, data: `data${id}.bin` };
}
// openssl's verdict on one signature: true when it verifies.
function opensslVerifies(bytes, r, ...trust) {
  const { sig, data } = extract(bytes, r);
  const res = ok("cms", "-verify", "-binary", "-inform", "DER", "-in", sig, "-content", data, ...(trust.length ? trust : ["-noverify"]), "-out", "/dev/null");
  if (res.status !== 0) console.log(`      openssl: ${res.stderr.trim().split("\n")[0]}`);
  return res.status === 0;
}

const when = new Date("2026-10-18T09:30:00Z");
const rsa = await openCertificate(p12("rsa.p12"), pw);

await test("a legacy (3DES) .p12 opens, with a key that can't be exported", async () => {
  eq(rsa.info.name, "Nopload Test Signer", "certificate name");
  eq(rsa.info.selfSigned, true, "self-signed");
  eq(rsa.key.extractable, false, "key extractable");
  eq(rsa.chain.length, 1, "certificates");
});

await test("AES-256 .p12 files open (OpenSSL 3's default, and node-forge's)", async () => {
  for (const f of ["aes-openssl.p12", "aes.p12"]) eq((await openCertificate(p12(f), pw)).info.name, "Nopload Test Signer", f);
});

await test("a wrong password, a file without a key and a file that isn't a .p12 are refused", async () => {
  const code = (p) => p.then(() => "opened", (e) => e.code);
  eq(await code(openCertificate(p12("rsa.p12"), pw + "x")), "wrong_password", "wrong password");
  eq(await code(openCertificate(p12("rsa.p12"), "")), "wrong_password", "no password");
  eq(await code(openCertificate(p12("nokey.p12"), pw)), "no_key", "no key");
  eq(await code(openCertificate(new Uint8Array(readFileSync(at("rsa.pem"))), pw)), "not_p12", "PEM file");
  eq(await code(openCertificate(report, pw)), "not_p12", "a PDF");
});

let signed;
await test("a signed file keeps the original bytes, opens, and its signature is valid PAdES B-B", async () => {
  signed = await signPdf(report, rsa, { reason: "Approved", location: "Zürich", date: when });
  eq(Buffer.from(signed.subarray(0, report.length)).equals(Buffer.from(report)), true, "original bytes kept");
  eq(await pages(signed), await pages(report), "pages");
  eq(await qpdfWarnings(signed), "", "qpdf warnings");
  await PDFDocument.load(signed);
  const [r, ...rest] = await checkSignatures(signed);
  eq(rest.length, 0, "extra signatures");
  eq(r.status, "valid", "status");
  eq(r.pades, true, "PAdES");
  eq(r.subFilter, "ETSI.CAdES.detached", "SubFilter");
  eq(r.wholeFile, true, "covers the whole file");
  eq(r.signer?.name, "Nopload Test Signer", "signer");
  eq(r.signer?.selfSigned, true, "self-signed");
  eq(r.reason, "Approved", "reason");
  eq(r.location, "Zürich", "location");
  eq(r.signedAt?.toISOString(), when.toISOString(), "signing time");
  eq(r.hash, "SHA-256", "digest");
  eq(r.timestamped, false, "timestamp");
  eq(r.field, "Signature1", "field");
});

await test("openssl cms verifies it, with signing-certificate-v2 and no signing-time attribute", async () => {
  const [r] = await checkSignatures(signed);
  eq(opensslVerifies(signed, r), true, "openssl -noverify");
  eq(opensslVerifies(signed, r, "-CAfile", "rsa.pem", "-purpose", "any"), true, "openssl, trusting the certificate");
  const printed = openssl("cms", "-cmsout", "-print", "-inform", "DER", "-in", extract(signed, r).sig).toString();
  // By OID: LibreSSL has no name for signing-certificate-v2.
  eq(printed.includes("(1.2.840.113549.1.9.16.2.47)"), true, "signing-certificate-v2 present");
  eq(printed.includes("(1.2.840.113549.1.9.5)"), false, "signing-time absent");
  eq(printed.includes("(1.2.840.113549.1.9.4)") && printed.includes("(1.2.840.113549.1.9.3)"), true, "message digest and content type present");
});

for (const streams of [false, true]) {
  await test(`a file with ${streams ? "a cross-reference stream" : "a cross-reference table"} gets the same kind of update, and verifies`, async () => {
    const input = await made(streams);
    const out = await signPdf(input, rsa, { date: when });
    const tail = Buffer.from(out.subarray(input.length)).toString("latin1");
    eq(/\/Type \/XRef/.test(tail), streams, "xref stream in the update");
    eq(/\nxref\n/.test(tail), !streams, "xref table in the update");
    eq(await pages(out), 2, "pages");
    eq(await qpdfWarnings(out), "", "qpdf warnings");
    const [r] = await checkSignatures(out);
    eq(r.status, "valid", "status");
    eq(opensslVerifies(out, r), true, "openssl");
  });
}

await test("an EC P-256 certificate signs, and openssl verifies it", async () => {
  const ec = await openCertificate(p12("ec.p12"), pw);
  const out = await signPdf(report, ec, { date: when });
  const [r] = await checkSignatures(out);
  eq(r.status, "valid", "status");
  eq(r.signer?.name, "Nopload EC Signer", "signer");
  eq(opensslVerifies(out, r), true, "openssl");
});

await test("a certificate issued by a CA embeds the chain, and openssl verifies the chain to that CA", async () => {
  const leaf = await openCertificate(p12("chain.p12"), pw);
  eq(leaf.info.name, "Nopload Leaf Signer", "signing certificate picked");
  eq(leaf.chain.length, 2, "chain");
  const out = await signPdf(report, leaf, { date: when });
  const [r] = await checkSignatures(out);
  eq(r.status, "valid", "status");
  eq(r.signer?.selfSigned, false, "self-signed");
  eq(r.signer?.issuer, "Nopload Test CA", "issuer");
  eq(r.chain.map((c) => c.name).join(), "Nopload Test CA", "chain names");
  eq(opensslVerifies(out, r, "-CAfile", "ca.pem", "-purpose", "any"), true, "openssl with the CA");
});

// ── Tampering
const flip = (bytes, i, to) => {
  const out = bytes.slice();
  out[i] = to ?? (out[i] === 0x31 ? 0x32 : 0x31);
  return out;
};
await test("one byte changed in the first range: the checker says modified, openssl fails", async () => {
  const [r] = await checkSignatures(signed);
  // A digit in the "%PDF-1.x" header.
  const out = flip(signed, 7);
  const [t] = await checkSignatures(out);
  eq(t.status, "modified", "status");
  eq(opensslVerifies(out, r), false, "openssl");
});

await test("one byte changed in the second range (the signing time) is caught too", async () => {
  const s = Buffer.from(signed).toString("latin1");
  const i = s.lastIndexOf("/M (D:") + 8;
  const [r] = await checkSignatures(signed);
  eq(i > r.bytes[2], true, "inside the second range");
  const out = flip(signed, i);
  eq((await checkSignatures(out))[0].status, "modified", "status");
  eq(opensslVerifies(out, r), false, "openssl");
});

await test("one hex digit of the signature changed: not valid", async () => {
  const [r] = await checkSignatures(signed);
  // Near the end of the blob: inside the RSA signature value.
  const der = extract(signed, r).sig;
  const n = readFileSync(at(der)).length;
  const i = r.bytes[1] + 1 + (n - 10) * 2;
  const out = flip(signed, i, signed[i] === 0x61 ? 0x62 : 0x61);
  const [t] = await checkSignatures(out);
  eq(t.status === "invalid" || t.status === "malformed", true, `status ${t.status}`);
});

// An incremental update that changes the title, as an editor saving over a signed file would.
function appendUpdate(bytes, title) {
  const s = Buffer.from(bytes).toString("latin1");
  const prev = +/startxref\s+(\d+)/.exec(s.slice(s.lastIndexOf("startxref")))[1];
  const root = /\/Root\s+(\d+ \d+ R)/.exec(s.slice(s.lastIndexOf("/Root")))[1];
  const size = Math.max(...[...s.matchAll(/\/Size\s+(\d+)/g)].map((m) => +m[1]));
  const objAt = bytes.length;
  const body = `${size} 0 obj\n<< /Title ${PDFString.of(title)} >>\nendobj\n`;
  const xrefAt = objAt + body.length;
  const tail = `xref\n${size} 1\n${String(objAt).padStart(10, "0")} 00000 n\r\ntrailer\n<< /Size ${size + 1} /Root ${root} /Info ${size} 0 R /Prev ${prev} >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return new Uint8Array(Buffer.concat([Buffer.from(bytes), Buffer.from(body + tail, "latin1")]));
}

await test("a change saved after signing is reported, while the signed revision still verifies", async () => {
  const out = appendUpdate(signed, "Changed later");
  const doc = await PDFDocument.load(out, { updateMetadata: false });
  eq(doc.getTitle(), "Changed later", "the update took");
  const [r] = await checkSignatures(out);
  eq(r.status, "valid", "status");
  eq(r.wholeFile, false, "covers the whole file");
  eq(r.laterSignatures, 0, "later signatures");
  eq(opensslVerifies(out, r), true, "openssl on the signed revision");
});

await test("a second signature keeps the first: both verify, and the first knows it was signed again", async () => {
  const leaf = await openCertificate(p12("chain.p12"), pw);
  const twice = await signPdf(signed, leaf, { date: when });
  eq(Buffer.from(twice.subarray(0, signed.length)).equals(Buffer.from(signed)), true, "first signed file kept");
  const [a, b] = await checkSignatures(twice);
  eq(a.status, "valid", "first status");
  eq(b.status, "valid", "second status");
  eq(a.wholeFile, false, "first covers the whole file");
  eq(a.laterSignatures, 1, "first: later signatures");
  eq(b.wholeFile, true, "second covers the whole file");
  eq(a.field, "Signature1", "first field");
  eq(b.field, "Signature2", "second field");
  eq(b.signer?.name, "Nopload Leaf Signer", "second signer");
  eq(opensslVerifies(twice, a), true, "openssl, first");
  eq(opensslVerifies(twice, b), true, "openssl, second");
  eq(await qpdfWarnings(twice), "", "qpdf warnings");
});

await test("a signed file rewritten by another tool no longer checks out", async () => {
  const doc = await PDFDocument.load(signed, { updateMetadata: false });
  doc.setTitle("Rewritten");
  const out = new Uint8Array(await doc.save());
  const all = await checkSignatures(out);
  eq(all.length, 1, "signatures found");
  eq(all[0].status === "valid", false, `status ${all[0].status}`);
});

// ── Other inputs
await test("an unsigned file has no signatures", async () => {
  eq((await checkSignatures(report)).length, 0, "signatures");
});

await test("a file whose startxref is wrong is written afresh, then signed", async () => {
  const s = Buffer.from(await made(false)).toString("latin1");
  const broken = new Uint8Array(Buffer.from(s.replace(/startxref\s+\d+/, "startxref\n99999999"), "latin1"));
  const out = await signPdf(broken, rsa, { date: when });
  const [r] = await checkSignatures(out);
  eq(r.status, "valid", "status");
  eq(await pages(out), 2, "pages");
  eq(opensslVerifies(out, r), true, "openssl");
});

await test("a password-protected file is refused", async () => {
  const locked = new Uint8Array(readFileSync(join(root, "tests/fixtures/locked-report.pdf")));
  eq(await signPdf(locked, rsa).then(() => "signed", (e) => e.code), "encrypted", "error");
});

{
  const doc = await PDFDocument.load(signed);
  const field = doc.getForm().getFields()[0];
  await test("the signature field is an invisible /Sig widget on page 1, with SigFlags 3", async () => {
    eq(field.acroField.dict.lookup(PDFName.of("FT"))?.toString(), "/Sig", "field type");
    eq(doc.catalog.lookup(PDFName.of("AcroForm")).lookup(PDFName.of("SigFlags"))?.toString(), "3", "SigFlags");
    const annots = doc.getPage(0).node.Annots();
    eq(annots?.size(), 1, "annotations on page 1");
  });
}

// ── poppler's pdfsig reads the whole file, as a PDF reader would.
const pdfsigPath = process.env.PDFSIG ?? ["/opt/homebrew/bin/pdfsig", "/usr/local/bin/pdfsig", "/usr/bin/pdfsig"].find(existsSync);
if (!pdfsigPath) console.log("skip  pdfsig: not installed (brew install poppler, or set PDFSIG)");
else {
  // One block per signature: "Signature #n:" then its "- Key: value" lines.
  const pdfsig = (bytes) => {
    const f = at(`pdfsig${++seq}.pdf`);
    writeFileSync(f, bytes);
    const res = spawnSync(pdfsigPath, [f], { encoding: "utf8" });
    if (res.error) throw new Error(`can't run ${pdfsigPath}: ${res.error.code}`);
    return res.stdout.split(/^Signature #\d+:$/m).slice(1);
  };
  const valid = (b) => b.includes("Signature Validation: Signature is Valid.");
  const whole = (b) => b.includes("Total document signed");

  await test("pdfsig: valid, covers the whole file, certificate untrusted (self-signed)", async () => {
    const [b, ...rest] = pdfsig(signed);
    eq(rest.length, 0, "extra signatures");
    eq(valid(b), true, "signature valid");
    eq(whole(b), true, "total document signed");
    eq(/Certificate Validation: Certificate is Trusted/.test(b), false, "certificate trusted");
    eq(/Signature Type: ETSI\.CAdES\.detached/.test(b), true, "PAdES type");
    eq(/Signing Hash Algorithm: SHA-256/.test(b), true, "SHA-256");
    eq(/Common Name: Nopload Test Signer/.test(b), true, "signer");
  });

  await test("pdfsig: EC and CA-issued signatures are valid too", async () => {
    for (const f of ["ec.p12", "chain.p12"]) {
      const [b] = pdfsig(await signPdf(report, await openCertificate(p12(f), pw), { date: when }));
      eq(valid(b) && whole(b), true, `${f} valid`);
    }
  });

  await test("pdfsig: one changed byte is a digest mismatch", async () => {
    const [b] = pdfsig(flip(signed, 7));
    eq(b.includes("Signature Validation: Digest Mismatch."), true, "digest mismatch");
  });

  await test("pdfsig: a change saved after signing is not part of the signed document", async () => {
    const [b] = pdfsig(appendUpdate(signed, "Changed later"));
    eq(valid(b), true, "signed revision still valid");
    eq(whole(b), false, "total document signed");
  });

  await test("pdfsig: both signatures of a twice-signed file are valid, the first covers only its revision", async () => {
    const twice = await signPdf(signed, await openCertificate(p12("chain.p12"), pw), { date: when });
    const [a, b] = pdfsig(twice);
    eq(valid(a) && valid(b), true, "both valid");
    eq(whole(a), false, "first: total document signed");
    eq(whole(b), true, "second: total document signed");
  });
}

process.exit(results.failed ? 1 : 0);
