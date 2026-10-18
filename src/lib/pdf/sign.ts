// Certificate signatures, made and checked on this device.
//
// Signing writes a PAdES baseline B-B signature (ETSI EN 319 142-1): a CMS
// SignedData over the file's bytes, minus the gap that holds it, with the
// content type, message digest and signing-certificate-v2 attributes. It is
// appended as an incremental update, so the bytes already in the file, and
// any signatures they carry, stay exactly as they were.
//
// There is no RFC 3161 timestamp: that needs a request to a timestamp server
// on another site. The signing time is this device's clock, written as /M,
// which a reader takes on trust.
//
// Checking finds every signature, recomputes the digest over its byte range,
// verifies the CMS signature with the certificate it carries, and reports
// whether anything was added to the file after it. It doesn't decide whether
// the certificate is trusted or revoked: that needs trust lists and
// revocation servers.

import * as asn1js from "asn1js";
import * as pkijs from "pkijs";
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFRef, PDFString, type PDFContext, type PDFObject } from "pdf-lib";
import { PdfError } from "./errors";
import { loadPdf } from "./organize";
import { pdfBlob } from "./common";

// A private key that never leaves WebCrypto (imported as non-extractable)
// and its certificates as DER, the signer's own first.
export type Signer = { key: CryptoKey; chain: Uint8Array[] };
export type SignInfo = { reason?: string; location?: string; date?: Date };

const OID = {
  data: "1.2.840.113549.1.7.1",
  signedData: "1.2.840.113549.1.7.2",
  contentType: "1.2.840.113549.1.9.3",
  messageDigest: "1.2.840.113549.1.9.4",
  signingTime: "1.2.840.113549.1.9.5",
  signingCertificate: "1.2.840.113549.1.9.16.2.12",
  signingCertificateV2: "1.2.840.113549.1.9.16.2.47",
  timestampToken: "1.2.840.113549.1.9.16.2.14",
  sha1: "1.3.14.3.2.26",
  sha256: "2.16.840.1.101.3.4.2.1",
  sha384: "2.16.840.1.101.3.4.2.2",
  sha512: "2.16.840.1.101.3.4.2.3",
  rsa: "1.2.840.113549.1.1.1",
  ec: "1.2.840.10045.2.1",
};
const HASHES: Record<string, string> = { [OID.sha1]: "SHA-1", [OID.sha256]: "SHA-256", [OID.sha384]: "SHA-384", [OID.sha512]: "SHA-512" };
export const CURVES: Record<string, string> = { "1.2.840.10045.3.1.7": "P-256", "1.3.132.0.34": "P-384", "1.3.132.0.35": "P-521" };

// The digest that matches the key: SHA-256, or longer for larger curves.
export function hashFor(key: CryptoKey) {
  const curve = (key.algorithm as EcKeyAlgorithm).namedCurve;
  return curve === "P-384" ? "SHA-384" : curve === "P-521" ? "SHA-512" : "SHA-256";
}

const latin1 = (s: string) => {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
};
const text = (b: Uint8Array) => {
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return s;
};
const hex = (b: ArrayBuffer | Uint8Array) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
const buf = (b: Uint8Array) => b.slice().buffer as ArrayBuffer;
const concat = (parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

// D:YYYYMMDDHHmmSSZ, in UTC.
const pdfDate = (d: Date) => `D:${d.toISOString().replace(/[-:T]/g, "").slice(0, 14)}Z`;

export function parsePdfDate(s: string): Date | undefined {
  const m = /^D:(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?(?:([+\-Z])(\d{2})?'?(\d{2})?'?)?/.exec(s.trim());
  if (!m) return undefined;
  const [y, mo = "01", d = "01", h = "00", mi = "00", se = "00"] = m.slice(1, 7).map((x) => x || undefined) as string[];
  let t = Date.UTC(+y, +mo - 1, +d, +h, +mi, +se);
  if (m[7] === "+" || m[7] === "-") t -= (m[7] === "+" ? 1 : -1) * ((+(m[8] ?? 0)) * 60 + +(m[9] ?? 0)) * 60000;
  return Number.isNaN(t) ? undefined : new Date(t);
}

// ── The file's last cross-reference section, which the update points back to.
type Xref = { offset: number; stream: boolean; size: number };

function lastXref(bytes: Uint8Array): Xref | null {
  const tail = text(bytes.subarray(Math.max(0, bytes.length - 2048)));
  const m = /startxref\s+(\d+)\s*(?:%%EOF)?\s*$/.exec(tail.slice(tail.lastIndexOf("startxref")));
  if (!m) return null;
  const offset = +m[1];
  if (offset <= 0 || offset >= bytes.length) return null;
  const at = text(bytes.subarray(offset, Math.min(bytes.length, offset + 64)));
  if (at.startsWith("xref")) {
    const rest = text(bytes.subarray(offset));
    const trailer = rest.indexOf("trailer");
    const size = trailer < 0 ? null : /\/Size\s+(\d+)/.exec(rest.slice(trailer));
    return size ? { offset, stream: false, size: +size[1] } : null;
  }
  if (/^\d+\s+\d+\s+obj\b/.test(at)) {
    const head = text(bytes.subarray(offset, Math.min(bytes.length, offset + 4096)));
    const dict = head.slice(0, head.indexOf("stream"));
    const size = /\/Size\s+(\d+)/.exec(dict);
    return /\/Type\s*\/XRef\b/.test(dict) && size ? { offset, stream: true, size: +size[1] } : null;
  }
  return null;
}

const isSigDict = (o: PDFObject | undefined): o is PDFDict =>
  o instanceof PDFDict && o.get(PDFName.of("ByteRange")) instanceof PDFArray && o.has(PDFName.of("Contents"));

function firstPage(ctx: PDFContext, catalog: PDFDict): { ref: PDFRef; dict: PDFDict } {
  let ref = catalog.get(PDFName.of("Pages"));
  for (let depth = 0; depth < 64 && ref instanceof PDFRef; depth++) {
    const dict = ctx.lookup(ref);
    if (!(dict instanceof PDFDict)) break;
    if (dict.get(PDFName.of("Type")) === PDFName.of("Page")) return { ref, dict };
    const kids = dict.lookup(PDFName.of("Kids"));
    ref = kids instanceof PDFArray ? kids.get(0) : undefined;
  }
  throw new PdfError("damaged");
}

const cloneArray = (ctx: PDFContext, a: PDFObject | undefined) => {
  const out = PDFArray.withContext(ctx);
  if (a instanceof PDFArray) for (let i = 0; i < a.size(); i++) out.push(a.get(i));
  return out;
};

const PLACEHOLDER_RANGE = "[0 ********** ********** **********]";

// Signs a PDF. Returns the original bytes with the signature appended.
export async function signPdf(input: Uint8Array, signer: Signer, info: SignInfo = {}, name = "file.pdf"): Promise<Uint8Array> {
  let doc = await loadPdf(pdfBlob(input), name);
  let prev = lastXref(input);
  if (!prev) {
    // The file's own cross-reference data can't be built on. Without
    // signatures to keep, it can be written afresh first.
    if (doc.context.enumerateIndirectObjects().some(([, o]) => isSigDict(o))) throw new PdfError("damaged", name);
    input = await doc.save({ useObjectStreams: false, addDefaultPage: false });
    doc = await PDFDocument.load(input, { updateMetadata: false });
    prev = lastXref(input);
    if (!prev) throw new PdfError("damaged", name);
  }
  const ctx = doc.context;
  const { Root, Info, ID } = ctx.trailerInfo;
  if (!(Root instanceof PDFRef)) throw new PdfError("damaged", name);
  const catalog = ctx.lookup(Root, PDFDict);

  let next = Math.max(prev.size, ctx.largestObjectNumber + 1);
  const alloc = () => PDFRef.of(next++);
  const objects = new Map<PDFRef, string>();

  // The form, made indirect if it isn't already, with the new field and SigFlags 3.
  const acroRaw = catalog.get(PDFName.of("AcroForm"));
  const acroLooked = acroRaw instanceof PDFRef ? ctx.lookup(acroRaw) : acroRaw;
  const acro = acroLooked instanceof PDFDict ? acroLooked.clone(ctx) : ctx.obj({});
  const acroRef = acroRaw instanceof PDFRef ? acroRaw : alloc();
  const fieldsRaw = acro.get(PDFName.of("Fields"));
  const fields = cloneArray(ctx, fieldsRaw instanceof PDFRef ? ctx.lookup(fieldsRaw) : fieldsRaw);
  const taken = new Set<string>();
  for (let i = 0; i < fields.size(); i++) {
    const t = fields.lookup(i);
    const n = t instanceof PDFDict ? t.lookup(PDFName.of("T")) : undefined;
    if (n instanceof PDFString || n instanceof PDFHexString) taken.add(n.decodeText());
  }
  let n = 1;
  while (taken.has(`Signature${n}`)) n++;

  const page = firstPage(ctx, catalog);
  const sigRef = alloc();
  const apRef = alloc();
  const widgetRef = alloc();
  const widget = ctx.obj({
    Type: "Annot", Subtype: "Widget", FT: "Sig", T: PDFString.of(`Signature${n}`), V: sigRef,
    F: 132, Rect: [0, 0, 0, 0], P: page.ref, AP: { N: apRef },
  });
  objects.set(widgetRef, widget.toString());
  objects.set(apRef, "<<\n/Type /XObject\n/Subtype /Form\n/BBox [0 0 0 0]\n/Length 0\n>>\nstream\n\nendstream");

  fields.push(widgetRef);
  if (fieldsRaw instanceof PDFRef) objects.set(fieldsRaw, fields.toString());
  else acro.set(PDFName.of("Fields"), fields);
  const flags = acro.lookup(PDFName.of("SigFlags"));
  acro.set(PDFName.of("SigFlags"), PDFNumber.of((flags instanceof PDFNumber ? flags.asNumber() : 0) | 3));
  objects.set(acroRef, acro.toString());
  if (!(acroRaw instanceof PDFRef)) {
    const cat = catalog.clone(ctx);
    cat.set(PDFName.of("AcroForm"), acroRef);
    objects.set(Root, cat.toString());
  }

  // The widget goes on the first page, as an invisible signature does.
  const annotsRaw = page.dict.get(PDFName.of("Annots"));
  const annots = cloneArray(ctx, annotsRaw instanceof PDFRef ? ctx.lookup(annotsRaw) : annotsRaw);
  annots.push(widgetRef);
  if (annotsRaw instanceof PDFRef) objects.set(annotsRaw, annots.toString());
  else {
    const p = page.dict.clone(ctx);
    p.set(PDFName.of("Annots"), annots);
    objects.set(page.ref, p.toString());
  }

  // Room for the CMS: the certificates, the signature and its attributes.
  const room = signer.chain.reduce((s, c) => s + c.length, 0) + 4096;
  const cert = describeCertificate(signer.chain[0]);
  const sig = [
    "<<", "/Type /Sig", "/Filter /Adobe.PPKLite", "/SubFilter /ETSI.CAdES.detached",
    `/ByteRange ${PLACEHOLDER_RANGE}`, `/Contents <${"0".repeat(room * 2)}>`,
    `/M ${PDFString.of(pdfDate(info.date ?? new Date())).toString()}`,
    ...(cert.name ? [`/Name ${PDFHexString.fromText(cert.name).toString()}`] : []),
    ...(info.reason ? [`/Reason ${PDFHexString.fromText(info.reason).toString()}`] : []),
    ...(info.location ? [`/Location ${PDFHexString.fromText(info.location).toString()}`] : []),
    ">>",
  ].join("\n");
  objects.set(sigRef, sig);

  // Body, then the cross-reference section in the form the file already uses.
  const sep = input[input.length - 1] === 0x0a || input[input.length - 1] === 0x0d ? "" : "\n";
  let body = sep;
  const offsets = new Map<number, { gen: number; at: number }>();
  for (const [ref, obj] of objects) {
    offsets.set(ref.objectNumber, { gen: ref.generationNumber, at: input.length + body.length });
    body += `${ref.objectNumber} ${ref.generationNumber} obj\n${obj}\nendobj\n`;
  }
  const trailer = [`/Root ${Root}`, ...(Info ? [`/Info ${Info}`] : []), ...(ID ? [`/ID ${ID}`] : []), `/Prev ${prev.offset}`];
  const xrefAt = input.length + body.length;
  if (prev.stream) {
    const xrefRef = alloc();
    offsets.set(xrefRef.objectNumber, { gen: 0, at: xrefAt });
    const nums = [...offsets.keys()].sort((a, b) => a - b);
    const rows = nums.map((k) => {
      const { gen, at } = offsets.get(k)!;
      return String.fromCharCode(1, (at >>> 24) & 255, (at >>> 16) & 255, (at >>> 8) & 255, at & 255, (gen >>> 8) & 255, gen & 255);
    }).join("");
    body += `${xrefRef.objectNumber} 0 obj\n<<\n/Type /XRef\n/Size ${next}\n/W [1 4 2]\n/Index [${nums.map((k) => `${k} 1`).join(" ")}]\n${trailer.join("\n")}\n/Length ${rows.length}\n>>\nstream\n${rows}\nendstream\nendobj\n`;
  } else {
    const nums = [...offsets.keys()].sort((a, b) => a - b);
    body += "xref\n" + nums.map((k) => {
      const { gen, at } = offsets.get(k)!;
      return `${k} 1\n${String(at).padStart(10, "0")} ${String(gen).padStart(5, "0")} n\r\n`;
    }).join("") + `trailer\n<<\n/Size ${next}\n${trailer.join("\n")}\n>>\n`;
  }
  body += `startxref\n${xrefAt}\n%%EOF\n`;

  const update = latin1(body);
  const contentsAt = body.indexOf("/Contents <") + "/Contents ".length;
  const rangeAt = body.indexOf(PLACEHOLDER_RANGE);
  const gapStart = input.length + contentsAt;
  const gapEnd = gapStart + room * 2 + 2;
  const total = input.length + update.length;
  const range = `[0 ${gapStart} ${gapEnd} ${total - gapEnd}]`;
  update.set(latin1(range.padEnd(PLACEHOLDER_RANGE.length, " ")), rangeAt);

  const out = concat([input, update]);
  const hash = hashFor(signer.key);
  const digest = await crypto.subtle.digest(hash, concat([out.subarray(0, gapStart), out.subarray(gapEnd)]));
  const der = new Uint8Array(await cms(signer, digest, hash));
  if (der.length > room) throw new Error("Signature larger than the space reserved for it");
  out.set(latin1(hex(der)), gapStart + 1);
  return out;
}

// CMS SignedData, detached, with the PAdES B-B signed attributes.
async function cms(signer: Signer, digest: ArrayBuffer, hash: string) {
  const certs = signer.chain.map((d) => pkijs.Certificate.fromBER(d.slice()));
  const cert = certs[0];
  const certHash = await crypto.subtle.digest("SHA-256", buf(signer.chain[0]));
  // ESSCertIDv2 with the default hash (SHA-256) and the issuer and serial.
  const essCertId = new asn1js.Sequence({
    value: [
      new asn1js.OctetString({ valueHex: certHash }),
      new asn1js.Sequence({
        value: [
          new pkijs.GeneralNames({ names: [new pkijs.GeneralName({ type: 4, value: cert.issuer })] }).toSchema(),
          new asn1js.Integer({ valueHex: cert.serialNumber.valueBlock.valueHexView.slice().buffer }),
        ],
      }),
    ],
  });
  const attributes = [
    new pkijs.Attribute({ type: OID.contentType, values: [new asn1js.ObjectIdentifier({ value: OID.data })] }),
    new pkijs.Attribute({ type: OID.messageDigest, values: [new asn1js.OctetString({ valueHex: digest })] }),
    new pkijs.Attribute({ type: OID.signingCertificateV2, values: [new asn1js.Sequence({ value: [new asn1js.Sequence({ value: [essCertId] })] })] }),
  ];
  // A DER SET OF is sorted by encoding; verifiers re-encode it before checking.
  const keyed = attributes.map((a) => ({ a, k: new Uint8Array(a.toSchema().toBER()) }));
  keyed.sort((x, y) => {
    for (let i = 0; i < Math.min(x.k.length, y.k.length); i++) if (x.k[i] !== y.k[i]) return x.k[i] - y.k[i];
    return x.k.length - y.k.length;
  });
  const signed = new pkijs.SignedData({
    version: 1,
    encapContentInfo: new pkijs.EncapsulatedContentInfo({ eContentType: OID.data }),
    certificates: certs,
    signerInfos: [
      new pkijs.SignerInfo({
        version: 1,
        sid: new pkijs.IssuerAndSerialNumber({ issuer: cert.issuer, serialNumber: cert.serialNumber }),
        signedAttrs: new pkijs.SignedAndUnsignedAttributes({ type: 0, attributes: keyed.map((x) => x.a) }),
      }),
    ],
  });
  await signed.sign(signer.key, 0, hash);
  return new pkijs.ContentInfo({ contentType: OID.signedData, content: signed.toSchema(true) }).toSchema().toBER(false);
}

// ── Certificates
export type CertInfo = {
  name: string;
  organization?: string;
  email?: string;
  issuer: string;
  serial: string;
  notBefore: Date;
  notAfter: Date;
  selfSigned: boolean;
};

const rdn = (n: pkijs.RelativeDistinguishedNames, oid: string) => {
  const v = n.typesAndValues.find((t) => t.type === oid)?.value as { valueBlock?: { value?: unknown } } | undefined;
  return typeof v?.valueBlock?.value === "string" ? v.valueBlock.value : undefined;
};
const nameOf = (n: pkijs.RelativeDistinguishedNames) =>
  rdn(n, "2.5.4.3") ?? rdn(n, "2.5.4.10") ?? rdn(n, "1.2.840.113549.1.9.1") ?? rdn(n, "2.5.4.11") ?? "";

function infoOf(c: pkijs.Certificate): CertInfo {
  return {
    name: nameOf(c.subject),
    organization: rdn(c.subject, "2.5.4.10"),
    email: rdn(c.subject, "1.2.840.113549.1.9.1"),
    issuer: nameOf(c.issuer),
    serial: hex(c.serialNumber.valueBlock.valueHexView),
    notBefore: c.notBefore.value,
    notAfter: c.notAfter.value,
    selfSigned: c.subject.isEqual(c.issuer),
  };
}

export const describeCertificate = (der: Uint8Array) => infoOf(pkijs.Certificate.fromBER(der.slice()));

// ── Checking
export type SignatureStatus =
  | "valid" // the signed bytes are unchanged and the signature matches its certificate
  | "modified" // the bytes it covers were changed
  | "invalid" // the signature doesn't match its certificate or its own attributes
  | "unsupported" // a kind of signature this can't check
  | "malformed"; // the signature data is damaged

export type SignatureReport = {
  field?: string;
  kind: "signature" | "timestamp";
  status: SignatureStatus;
  subFilter: string;
  pades: boolean;
  // Nothing was added to the file after this signature.
  wholeFile: boolean;
  // Signatures made after this one, in later revisions.
  laterSignatures: number;
  signer?: CertInfo;
  chain: CertInfo[];
  signedAt?: Date; // as the signer's device claimed it
  reason?: string;
  location?: string;
  hash?: string;
  // An RFC 3161 timestamp token is attached (not checked).
  timestamped: boolean;
  revision: number; // 1-based, in the order they were signed
  bytes: [number, number, number, number];
};

const decode = (o: PDFObject | undefined) => (o instanceof PDFString || o instanceof PDFHexString ? o.decodeText() : undefined);

const isHex = (c: number) => (c >= 48 && c <= 57) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102);
const isSpace = (c: number) => c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09 || c === 0x0c || c === 0;

export async function checkSignatures(bytes: Uint8Array): Promise<SignatureReport[]> {
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false, throwOnInvalidObject: false });
  } catch (e) {
    throw new PdfError("damaged", "", e);
  }
  const ctx = doc.context;
  const encrypted = !!ctx.trailerInfo.Encrypt;
  const objects = ctx.enumerateIndirectObjects();
  const fieldOf = new Map<string, string>();
  for (const [, o] of objects) {
    if (!(o instanceof PDFDict)) continue;
    const v = o.get(PDFName.of("V"));
    if (!(v instanceof PDFRef)) continue;
    const parent = o.lookup(PDFName.of("Parent"));
    const t = decode(o.lookup(PDFName.of("T"))) ?? (parent instanceof PDFDict ? decode(parent.lookup(PDFName.of("T"))) : undefined);
    if (t !== undefined) fieldOf.set(v.toString(), t);
  }

  const found: { ref: PDFRef; dict: PDFDict; range: number[] }[] = [];
  for (const [ref, o] of objects) {
    if (!isSigDict(o)) continue;
    const a = o.lookup(PDFName.of("ByteRange"), PDFArray);
    const range = a.asArray().map((x) => (x instanceof PDFNumber ? x.asNumber() : NaN));
    found.push({ ref, dict: o, range });
  }
  const end = (r: number[]) => (r.length === 4 ? r[2] + r[3] : 0);
  found.sort((x, y) => end(x.range) - end(y.range));

  const reports: SignatureReport[] = [];
  for (const [i, { ref, dict, range }] of found.entries()) {
    const sf = dict.lookup(PDFName.of("SubFilter"));
    const subFilter = sf instanceof PDFName ? sf.decodeText() : "";
    const kind = dict.get(PDFName.of("Type")) === PDFName.of("DocTimeStamp") || subFilter === "ETSI.RFC3161" ? "timestamp" : "signature";
    const m = decode(dict.lookup(PDFName.of("M")));
    const r: SignatureReport = {
      field: fieldOf.get(ref.toString()),
      kind,
      status: "malformed",
      subFilter,
      pades: false,
      wholeFile: false,
      laterSignatures: found.length - 1 - i,
      chain: [],
      signedAt: m ? parsePdfDate(m) : undefined,
      reason: encrypted ? undefined : decode(dict.lookup(PDFName.of("Reason"))),
      location: encrypted ? undefined : decode(dict.lookup(PDFName.of("Location"))),
      timestamped: false,
      revision: i + 1,
      bytes: [range[0], range[1], range[2], range[3]],
    };
    reports.push(r);

    const [a, b, c, d] = range;
    if (range.length !== 4 || range.some((x) => !Number.isInteger(x) || x < 0) || a !== 0 || b <= 0 || c <= b + 1 || c + d > bytes.length) continue;
    // Everything after the range is whitespace: nothing was added after signing.
    let after = c + d;
    while (after < bytes.length && isSpace(bytes[after])) after++;
    r.wholeFile = after === bytes.length;

    // The gap must be exactly the /Contents hex string, and the same bytes as the dictionary holds.
    if (bytes[b] !== 0x3c || bytes[c - 1] !== 0x3e) continue;
    let hexBody = "";
    let ok = true;
    for (let k = b + 1; k < c - 1; k++) {
      if (isHex(bytes[k])) hexBody += String.fromCharCode(bytes[k]);
      else if (!isSpace(bytes[k])) ok = false;
    }
    if (!ok) continue;
    const contents = dict.lookup(PDFName.of("Contents"));
    const held = contents instanceof PDFHexString || contents instanceof PDFString ? contents.asBytes() : null;
    if (!held || hex(held) !== hexBody.toLowerCase().padEnd(held.length * 2, "0").slice(0, held.length * 2)) continue;

    const signed = concat([bytes.subarray(0, b), bytes.subarray(c, c + d)]);
    await verifyCms(held, signed, subFilter, r);
  }
  return reports;
}

async function verifyCms(der: Uint8Array, signed: Uint8Array, subFilter: string, r: SignatureReport) {
  if (!["adbe.pkcs7.detached", "ETSI.CAdES.detached", "adbe.pkcs7.sha1", "ETSI.RFC3161"].includes(subFilter)) {
    r.status = "unsupported";
    return;
  }
  let sd: pkijs.SignedData;
  try {
    const parsed = asn1js.fromBER(buf(der));
    if (parsed.offset === -1) return;
    const info = new pkijs.ContentInfo({ schema: parsed.result });
    if (info.contentType !== OID.signedData) return;
    sd = new pkijs.SignedData({ schema: info.content });
  } catch {
    return;
  }
  const si = sd.signerInfos[0];
  if (!si) return;
  r.hash = HASHES[si.digestAlgorithm.algorithmId];
  r.timestamped = !!si.unsignedAttrs?.attributes.some((x) => x.type === OID.timestampToken);
  const certs = (sd.certificates ?? []).filter((c): c is pkijs.Certificate => c instanceof pkijs.Certificate);
  const signingTime = si.signedAttrs?.attributes.find((x) => x.type === OID.signingTime)?.values[0] as asn1js.UTCTime | asn1js.GeneralizedTime | undefined;
  if (!r.signedAt && signingTime) r.signedAt = signingTime.toDate();

  // adbe.pkcs7.sha1 signs the SHA-1 of the range, carried inside the CMS.
  let data: ArrayBuffer = buf(signed);
  if (subFilter === "adbe.pkcs7.sha1") {
    const inner = sd.encapContentInfo.eContent?.getValue();
    const sha1 = await crypto.subtle.digest("SHA-1", data);
    if (!inner || hex(inner) !== hex(sha1)) {
      r.status = "modified";
      return;
    }
    data = new ArrayBuffer(0);
  }

  let signer: pkijs.Certificate | null = null;
  try {
    const res = await sd.verify({ signer: 0, data, extendedMode: true, checkChain: false });
    signer = res.signerCertificate ?? null;
    r.status = res.signatureVerified ? "valid" : "invalid";
  } catch (e) {
    const err = e as pkijs.SignedDataVerifyError;
    signer = err.signerCertificate ?? null;
    r.status = /digest doesn't match/i.test(err.message ?? "") ? "modified" : err.code === 7 ? "unsupported" : signer ? "invalid" : "malformed";
  }
  if (!signer) return;
  r.signer = infoOf(signer);
  if (r.signer.selfSigned) r.signer.selfSigned = await signer.verify().catch(() => false);
  r.chain = certs.filter((c) => c !== signer).map(infoOf);

  // signing-certificate-v2 (or v1) must name the certificate that signed.
  const v2 = si.signedAttrs?.attributes.find((x) => x.type === OID.signingCertificateV2);
  const v1 = si.signedAttrs?.attributes.find((x) => x.type === OID.signingCertificate);
  const essAttr = v2 ?? v1;
  if (essAttr) {
    try {
      const first = (essAttr.values[0] as asn1js.Sequence).valueBlock.value[0] as asn1js.Sequence;
      const id = first.valueBlock.value[0] as asn1js.Sequence;
      const parts = id.valueBlock.value;
      const hasAlg = v2 && parts[0] instanceof asn1js.Sequence;
      const alg = v2 ? (hasAlg ? HASHES[((parts[0] as asn1js.Sequence).valueBlock.value[0] as asn1js.ObjectIdentifier).valueBlock.toString()] : "SHA-256") : "SHA-1";
      const want = (parts[hasAlg ? 1 : 0] as asn1js.OctetString).valueBlock.valueHexView;
      const got = alg ? await crypto.subtle.digest(alg, signer.toSchema().toBER()) : null;
      if (!got || hex(got) !== hex(want)) {
        if (r.status === "valid") r.status = "invalid";
        return;
      }
    } catch {
      if (r.status === "valid") r.status = "invalid";
      return;
    }
  }
  r.pades = r.status === "valid" && subFilter === "ETSI.CAdES.detached" && !!v2;
}
