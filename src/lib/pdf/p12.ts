// Opens a .p12/.pfx certificate file for signing, on this device. node-forge
// reads the file because it decrypts every protection in use, including the
// legacy 3DES and RC2 that WebCrypto lacks (and that many exported files
// still use). The private key is then handed to WebCrypto as non-extractable,
// so nothing can read it back out; the file and password aren't kept.

import forge from "node-forge";
import * as asn1js from "asn1js";
import * as pkijs from "pkijs";
import { CURVES, describeCertificate, type CertInfo, type Signer } from "./sign";

export type CertErrorCode = "not_p12" | "wrong_password" | "no_key" | "no_certificate" | "unsupported_key";
export class CertError extends Error {
  code: CertErrorCode;
  constructor(code: CertErrorCode, cause?: unknown) {
    super(code, cause === undefined ? undefined : { cause });
    this.name = "CertError";
    this.code = code;
  }
}

export type OpenedCertificate = Signer & { info: CertInfo };

const binary = (b: Uint8Array) => {
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return s;
};
const bytes = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));
const der = (a: forge.asn1.Asn1) => bytes(forge.asn1.toDer(a).getBytes());

type KeyAlg = { importAlg: RsaHashedImportParams | EcKeyImportParams; signAlg: AlgorithmIdentifier | EcdsaParams };

function algorithmOf(pkcs8: Uint8Array): KeyAlg {
  let info: pkijs.PrivateKeyInfo;
  try {
    info = pkijs.PrivateKeyInfo.fromBER(pkcs8.slice());
  } catch (e) {
    throw new CertError("unsupported_key", e);
  }
  const id = info.privateKeyAlgorithm.algorithmId;
  if (id === "1.2.840.113549.1.1.1") {
    return { importAlg: { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, signAlg: { name: "RSASSA-PKCS1-v1_5" } };
  }
  if (id === "1.2.840.10045.2.1") {
    const params = info.privateKeyAlgorithm.algorithmParams;
    const curve = params instanceof asn1js.ObjectIdentifier ? CURVES[params.valueBlock.toString()] : undefined;
    if (curve) return { importAlg: { name: "ECDSA", namedCurve: curve }, signAlg: { name: "ECDSA", hash: curve === "P-384" ? "SHA-384" : curve === "P-521" ? "SHA-512" : "SHA-256" } };
  }
  throw new CertError("unsupported_key");
}

export async function openCertificate(data: Uint8Array, password: string): Promise<OpenedCertificate> {
  let asn1: forge.asn1.Asn1;
  try {
    asn1 = forge.asn1.fromDer(forge.util.createBuffer(binary(data)), false);
  } catch (e) {
    throw new CertError("not_p12", e);
  }
  let p12: forge.pkcs12.Pkcs12Pfx | null = null;
  // A file saved without a password can mean "" or no password at all.
  for (const pw of password ? [password] : ["", null]) {
    try {
      p12 = forge.pkcs12.pkcs12FromAsn1(asn1, false, pw as string);
      break;
    } catch (e) {
      const msg = e instanceof Error ? e.message : "";
      if (/Unsupported|not.*PKCS#12|ContentInfo|PFX/i.test(msg) && !/password|MAC|decrypt/i.test(msg)) throw new CertError("not_p12", e);
    }
  }
  if (!p12) throw new CertError("wrong_password");

  const oids = forge.pki.oids;
  const keyBags = [
    ...(p12.getBags({ bagType: oids.pkcs8ShroudedKeyBag })[oids.pkcs8ShroudedKeyBag] ?? []),
    ...(p12.getBags({ bagType: oids.keyBag })[oids.keyBag] ?? []),
  ];
  const certs = (p12.getBags({ bagType: oids.certBag })[oids.certBag] ?? []).flatMap((bag) => {
    const a = bag.cert ? forge.pki.certificateToAsn1(bag.cert) : (bag as { asn1?: forge.asn1.Asn1 }).asn1;
    return a ? [der(a)] : [];
  });
  if (!keyBags.length) throw new CertError("no_key");
  if (!certs.length) throw new CertError("no_certificate");

  for (const bag of keyBags) {
    const raw = bag.key ? forge.pki.wrapRsaPrivateKey(forge.pki.privateKeyToAsn1(bag.key)) : (bag as { asn1?: forge.asn1.Asn1 }).asn1;
    if (!raw) continue;
    const pkcs8 = der(raw);
    const alg = algorithmOf(pkcs8);
    let key: CryptoKey;
    try {
      key = await crypto.subtle.importKey("pkcs8", pkcs8, alg.importAlg, false, ["sign"]);
    } catch (e) {
      throw new CertError("unsupported_key", e);
    } finally {
      pkcs8.fill(0);
    }
    // The certificate whose public key checks a signature made with this key.
    const probe = crypto.getRandomValues(new Uint8Array(32));
    const sig = await crypto.subtle.sign(alg.signAlg, key, probe);
    for (const [i, cert] of certs.entries()) {
      const spki = pkijs.Certificate.fromBER(cert.slice()).subjectPublicKeyInfo.toSchema().toBER();
      const pub = await crypto.subtle.importKey("spki", spki, alg.importAlg, false, ["verify"]).catch(() => null);
      if (!pub || !(await crypto.subtle.verify(alg.signAlg, pub, sig, probe).catch(() => false))) continue;
      const chain = [cert, ...certs.filter((_, j) => j !== i)];
      return { key, chain, info: describeCertificate(cert) };
    }
  }
  throw new CertError("no_certificate");
}
