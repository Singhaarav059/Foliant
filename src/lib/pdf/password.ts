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
