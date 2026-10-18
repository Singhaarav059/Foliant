// PDF password limits, kept free of PDF libraries so forms can check a
// password before any engine loads.
//
// AES-256, the encryption Protect uses, keys on at most 127 bytes of the
// UTF-8 password. pdf.js reads only those 127 bytes, but this qpdf build
// hashes the whole password, so a longer one would make a file that nobody
// can open. Such passwords are refused rather than cut, since cutting could
// split a character and the person would not know which password works.
export const MAX_PASSWORD_BYTES = 127;

// For a password that is too long, how many of its characters fit; null when it all fits.
export function passwordTooLong(password: string): number | null {
  const enc = new TextEncoder();
  if (enc.encode(password).length <= MAX_PASSWORD_BYTES) return null;
  let bytes = 0;
  let chars = 0;
  for (const ch of password) {
    bytes += enc.encode(ch).length;
    if (bytes > MAX_PASSWORD_BYTES) break;
    chars++;
  }
  return chars;
}

// The seven restrictions Protect can set, each allowed unless switched off.
export const PERMISSIONS = ["allowPrint", "allowPrintHigh", "allowCopy", "allowModify", "allowAnnotate", "allowForms", "allowAssemble"] as const;
export type Permissions = Partial<Record<(typeof PERMISSIONS)[number], boolean>>;

// What's wrong with Protect's form, if anything. Without an open password
// (`openPassword` off) the file opens for anyone, so at least one
// restriction must be set; the open password then isn't used.
export function protectProblem(o: { openPassword?: boolean; password: string; confirmPassword: string; ownerPassword?: string } & Permissions) {
  const open = o.openPassword !== false;
  if (open && !o.password) return { code: "passwordEmpty" as const };
  if (!open && !PERMISSIONS.some((k) => o[k] === false)) return { code: "noRestriction" as const };
  if (open && o.password !== o.confirmPassword) return { code: "passwordMismatch" as const };
  for (const p of [open ? o.password : "", o.ownerPassword ?? ""]) {
    const max = passwordTooLong(p);
    if (max !== null) return { code: "passwordTooLong" as const, max };
  }
  return null;
}

// A random password: four groups of five from 31 lowercase letters and
// digits that can't be mistaken for each other (no 0/o, 1/l/i), 99 bits.
const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
export function suggestPassword() {
  const chars: string[] = [];
  while (chars.length < 20) {
    // Bytes past the last whole multiple of 31 are skipped, so every character is equally likely.
    for (const b of crypto.getRandomValues(new Uint8Array(24))) if (b < 248 && chars.length < 20) chars.push(ALPHABET[b % 31]);
  }
  return [0, 5, 10, 15].map((i) => chars.slice(i, i + 5).join("")).join("-");
}

// A rough rating from 0 (none) to 4 (strong): the bits of a password drawn at
// random from the kinds of characters it uses, less for one that's common or
// one character over and over.
const COMMON = /^(password|passwort|qwerty|azerty|letmein|welcome|admin|iloveyou|abc|123|111|000)/i;
export function passwordStrength(password: string): 0 | 1 | 2 | 3 | 4 {
  if (!password) return 0;
  let pool = 0;
  if (/[a-z]/.test(password)) pool += 26;
  if (/[A-Z]/.test(password)) pool += 26;
  if (/[0-9]/.test(password)) pool += 10;
  if (/[^a-zA-Z0-9]/.test(password)) pool += 33;
  const chars = [...password];
  let bits = chars.length * Math.log2(Math.max(pool, 2)) * (new Set(chars).size / chars.length) ** 0.5;
  if (COMMON.test(password)) bits /= 2;
  return bits < 28 ? 1 : bits < 45 ? 2 : bits < 70 ? 3 : 4;
}
