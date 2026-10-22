"use client";

import {
  PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFObjectCopier, PDFPage, PDFPageLeaf, PDFRawStream, PDFRef, PDFString,
  decodePDFRawStream,
} from "pdf-lib";
import { baseName, bytesOf, canvasToBlob, closePdf, openPdf, pdfBlob, pdfjs, renderPage, type Output, type Progress, type RedactReport } from "./common";
import { prepareQpdf, runQpdf, QpdfError } from "./qpdf";
import { charBox, documentText, lineChars, pageText, type PageText } from "./text";
import { addInvisibleText } from "./textlayer";
import { runsToWords } from "./convert";
import { visualFrame, type FracRect } from "./edit";
import { decryptedCopy, preparePdfium, redactInPlace, type Box } from "./pdfium";
import { MAX_PASSWORD_BYTES, passwordTooLong, type Permissions } from "./password";
import { openForEdit, rebuilt } from "./open";

export class WrongPasswordError extends Error {
  code = "wrong_password";
}

// `max` is how many characters of the password would fit.
export class PasswordTooLongError extends Error {
  code = "password_too_long";
  constructor(public max: number) {
    super(`A PDF password can have at most ${MAX_PASSWORD_BYTES} bytes`);
  }
}

// The protected file didn't open with the password it was made with.
export class ProtectUnverifiedError extends Error {
  code = "protect_unverified";
  constructor(public fileName: string) {
    super(`${fileName} did not open with its new password`);
  }
}

// qpdf gives up on some damage every reader gets past (junk before the
// header, a broken cross-reference stream, a page tree thousands of levels
// deep): then it runs again on repaired copies. First the file from its
// header on, with its last cross-reference section found by searching; then
// what `repair` writes (Unlock: PDFium, which decrypts); last a copy pdf-lib
// rebuilt, which can't read encrypted object streams. A wrong password is
// not damage.
async function qpdfOrRebuilt(bytes: Uint8Array, args: Parameters<typeof runQpdf>[1], repair?: (bytes: Uint8Array) => Promise<Uint8Array>) {
  try {
    return await runQpdf(bytes, args);
  } catch (e) {
    if (e instanceof QpdfError && e.wrongPassword) throw e;
    const header = headerAt(bytes);
    const body = header > 0 ? bytes.subarray(header) : bytes;
    const found = withFoundXref(body);
    const copies = [
      ...(body !== bytes ? [body] : []),
      ...(found ? [found] : []),
      ...(repair ? [() => repair(bytes), ...(found ? [() => repair(found)] : [])] : []),
      () => rebuilt(bytes),
    ];
    for (const copy of copies) {
      try {
        return await runQpdf(copy instanceof Uint8Array ? copy : await copy(), args);
      } catch (again) {
        if (again instanceof QpdfError && again.wrongPassword) throw again;
      }
    }
    throw e;
  }
}

// Where "%PDF-" starts, or -1.
function headerAt(bytes: Uint8Array) {
  const sig = [0x25, 0x50, 0x44, 0x46, 0x2d];
  for (let i = 0; i + sig.length <= bytes.length; i++) if (sig.every((b, k) => bytes[i + k] === b)) return i;
  return -1;
}

// The file with its startxref pointing at its last cross-reference table or
// stream, found by searching; undefined when it has none.
function withFoundXref(bytes: Uint8Array) {
  const text = new TextDecoder("latin1").decode(bytes);
  const table = Math.max(text.lastIndexOf("\nxref"), text.lastIndexOf("\rxref"));
  let at = table >= 0 ? table + 1 : -1;
  const stream = text.lastIndexOf("/XRef");
  if (stream > at) {
    const before = text.slice(Math.max(0, stream - 4096), stream);
    const objs = [...before.matchAll(/(?:^|[^\d])(\d+\s+\d+\s+obj)\b/g)];
    const last = objs[objs.length - 1];
    if (last?.index !== undefined) at = Math.max(at, stream - before.length + last.index + last[0].length - last[1].length);
  }
  if (at < 0) return undefined;
  const end = text.lastIndexOf("startxref");
  const keep = end > at ? bytes.subarray(0, end) : bytes;
  const tail = new TextEncoder().encode(`\nstartxref\n${at}\n%%EOF\n`);
  const out = new Uint8Array(keep.length + tail.length);
  out.set(keep);
  out.set(tail, keep.length);
  return out;
}

function randomPassword() {
  return Array.from(crypto.getRandomValues(new Uint8Array(24)), (b) => b.toString(36).padStart(2, "0")).join("");
}

// AES-256 unless AES-128 is asked for (older readers). A permission is
// allowed unless it's false. With no open password the file opens for anyone,
// and the restrictions still apply. Without an owner password of one's own a
// random one is used, so nobody can lift the restrictions. Accessibility
// (text for screen readers) is always allowed: PDF 2.0 says so, and qpdf
// ignores the flag for AES.
export async function protect(
  file: File,
  o: { password: string; ownerPassword?: string; encryption?: string } & Permissions,
): Promise<Output[]> {
  for (const p of [o.password, o.ownerPassword ?? ""]) {
    const max = passwordTooLong(p);
    if (max !== null) throw new PasswordTooLongError(max);
  }
  const owner = o.ownerPassword || randomPassword();
  const allowed = (k: keyof Permissions) => o[k] !== false;
  const yn = (k: keyof Permissions) => (allowed(k) ? "y" : "n");
  const bits = o.encryption === "aes128" ? ["--bits=128", "--use-aes=y"] : ["--bits=256"];
  const { output } = await qpdfOrRebuilt(await bytesOf(file), (i, out) => [
    // --name=value, so a password like "-v" or "@notes" isn't read as an option or a file to include.
    "--encrypt", `--user-password=${o.password}`, `--owner-password=${owner}`, ...bits,
    `--print=${!allowed("allowPrint") ? "none" : allowed("allowPrintHigh") ? "full" : "low"}`,
    `--extract=${yn("allowCopy")}`,
    `--modify-other=${yn("allowModify")}`,
    `--annotate=${yn("allowAnnotate")}`,
    `--form=${yn("allowForms")}`,
    `--assemble=${yn("allowAssemble")}`,
    "--",
    i, out,
  ]);
  // Never hand over a file its own password doesn't open.
  try {
    await closePdf(await openPdf(output, o.password));
  } catch (e) {
    if ((e as { name?: string }).name === "PasswordException") throw new ProtectUnverifiedError(file.name);
    throw e;
  }
  return [{ name: `${baseName(file.name)}-protected.pdf`, blob: pdfBlob(output) }];
}

export async function unlock(file: File, o: { password: string }): Promise<Output[]> {
  // qpdf reports a bad password only on stderr, so check it with pdf.js first.
  try {
    await closePdf(await openPdf(await file.arrayBuffer(), o.password));
  } catch (e) {
    if ((e as { name?: string }).name === "PasswordException") throw new WrongPasswordError(file.name);
  }
  try {
    const { output } = await qpdfOrRebuilt(await bytesOf(file), (i, out) => [`--password=${o.password}`, "--decrypt", i, out], (b) => decryptedCopy(b, o.password));
    return [{ name: `${baseName(file.name)}-unlocked.pdf`, blob: pdfBlob(output) }];
  } catch (e) {
    if (e instanceof QpdfError && e.wrongPassword) throw new WrongPasswordError(file.name);
    throw e;
  }
}

// The editor's quick marks. Plain spaces only: search text marks line breaks
// and column gaps with other whitespace, so a number never runs on into the
// next line (unless it wraps at a hyphen) or table cell.
export const PRESETS = {
  emails: /[\w.+-]+@[\w-]+\.[\w.-]+/g,
  phones: /(?:\+?\d[\d ().-]{7,}\d)/g,
  numbers: /\b\d[\d -]{6,}\d\b/g,
  // 13 to 19 digits in groups; kept only when the Luhn check passes.
  cards: /\b\d(?:[ -]?\d){12,18}\b/g,
  // Country, check digits, then up to 30 letters and digits; kept only when mod 97 gives 1.
  ibans: /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]){11,30}\b/g,
  // Twelve digits not starting with 0 or 1, in groups of four; kept only when the Verhoeff check passes.
  aadhaar: /\b[2-9]\d{3}[ -]?\d{4}[ -]?\d{4}\b/g,
  // India's PAN: five letters (the fourth names the holder's kind), four digits, a letter.
  pan: /\b[A-Z]{3}[ABCFGHJLPT][A-Z]\d{4}[A-Z]\b/g,
  // US Social Security numbers, without the ranges never issued.
  ssn: /\b(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b/g,
  // 31/12/2024, 12-31-24, 2024-12-31, 31 Dec 2024; kept only when day and month can be real.
  dates: /\b(?:\d{1,2}[./-]\d{1,2}[./-](?:\d{4}|\d{2})|\d{4}-\d{2}-\d{2}|\d{1,2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.? \d{4})\b/g,
};
export type PresetName = keyof typeof PRESETS;

const onlyDigits = (s: string) => s.replace(/\D/g, "");

// A length the card's network uses for its first digits (Visa, Mastercard,
// American Express, Discover, JCB, Diners, RuPay, Maestro, UnionPay).
function cardShape(d: string) {
  const n = d.length;
  const p = (s: string) => d.startsWith(s);
  const first2 = Number(d.slice(0, 2)), first4 = Number(d.slice(0, 4));
  if (p("4")) return n === 13 || n === 16 || n === 19;
  if ((first2 >= 51 && first2 <= 55) || (first4 >= 2221 && first4 <= 2720)) return n === 16;
  if (p("34") || p("37")) return n === 15;
  if (p("35") || p("6")) return n >= 16 && n <= 19;
  if (p("30") || p("36") || p("38") || p("39")) return n >= 14 && n <= 19;
  if (p("81") || p("82") || p("508")) return n === 16;
  if (p("50") || p("56") || p("57") || p("58")) return n >= 12 && n <= 19;
  return false;
}

// The Luhn check digit (payment cards).
export function luhn(digits: string) {
  if (!/^\d+$/.test(digits)) return false;
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2) d = d * 2 > 9 ? d * 2 - 9 : d * 2;
    sum += d;
  }
  return sum % 10 === 0;
}

// ISO 13616: the first four characters moved to the end, letters as 10–35, mod 97 is 1.
export function ibanValid(text: string) {
  const t = text.replace(/ /g, "");
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(t)) return false;
  let rest = 0;
  for (const ch of t.slice(4) + t.slice(0, 4)) {
    const v = /\d/.test(ch) ? ch : String(ch.charCodeAt(0) - 55);
    for (const d of v) rest = (rest * 10 + Number(d)) % 97;
  }
  return rest === 1;
}

// The Verhoeff check digit (Aadhaar).
const VD = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 2, 3, 4, 0, 6, 7, 8, 9, 5], [2, 3, 4, 0, 1, 7, 8, 9, 5, 6], [3, 4, 0, 1, 2, 8, 9, 5, 6, 7], [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
  [5, 9, 8, 7, 6, 0, 4, 3, 2, 1], [6, 5, 9, 8, 7, 1, 0, 4, 3, 2], [7, 6, 5, 9, 8, 2, 1, 0, 4, 3], [8, 7, 6, 5, 9, 3, 2, 1, 0, 4], [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
];
const VP = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 5, 7, 6, 2, 8, 3, 0, 9, 4], [5, 8, 0, 3, 7, 9, 6, 1, 4, 2], [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0], [4, 2, 8, 6, 5, 7, 3, 9, 0, 1], [2, 7, 9, 3, 8, 0, 6, 4, 1, 5], [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
];
export function verhoeff(digits: string) {
  if (!/^\d+$/.test(digits)) return false;
  let c = 0;
  for (let i = 0; i < digits.length; i++) c = VD[c][VP[i % 8][Number(digits[digits.length - 1 - i])]];
  return c === 0;
}

// A day 1–31 and a month 1–12, in either order for day and month.
function plausibleDate(text: string) {
  const n = text.match(/\d+/g)?.map(Number) ?? [];
  if (/^\d{4}-/.test(text)) return n[1] >= 1 && n[1] <= 12 && n[2] >= 1 && n[2] <= 31;
  if (/[A-Za-z]/.test(text)) return n[0] >= 1 && n[0] <= 31;
  const [a, b] = n;
  return a >= 1 && b >= 1 && ((a <= 31 && b <= 12) || (a <= 12 && b <= 31));
}

// Presets whose matches must also pass a check, so a number that only looks
// like a card, IBAN or Aadhaar isn't blacked out.
export const PRESET_CHECKS: Partial<Record<PresetName, (text: string) => boolean>> = {
  cards: (t) => cardShape(onlyDigits(t)) && luhn(onlyDigits(t)),
  ibans: ibanValid,
  aadhaar: (t) => verhoeff(onlyDigits(t)),
  dates: plausibleDate,
};

// A search the editor ran: typed text as a pattern, or a preset with its check.
export type Search = { pattern: RegExp; preset?: PresetName };

// findMatches for a search, without the matches its preset's check rejects.
export function searchMatches(pages: PageText[], search: Search) {
  const valid = search.preset ? PRESET_CHECKS[search.preset] : undefined;
  return findMatches(pages, search.pattern).filter((h) => !valid || valid(h.text));
}

// The editor's search box as a pattern: the text as typed, where any run of
// spaces matches any whitespace (so a phrase may wrap to the next line),
// optionally in the same case only and as whole words only.
export function searchPattern(query: string, o: { matchCase?: boolean; wholeWord?: boolean } = {}) {
  const body = query.trim().split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+");
  const [before, after] = o.wholeWord ? ["(?<![\\p{L}\\p{N}_])", "(?![\\p{L}\\p{N}_])"] : ["", ""];
  return new RegExp(before + body + after, o.matchCase ? "gu" : "giu");
}

// A page's text as one string to search, and where each character comes from:
// [line, run, index]. Lines join with a line break, or with nothing where one
// ends in a hyphen after a letter or digit and the next starts with one (a
// word, number or code wrapped there). Such a hyphen may be part of the text
// (well-known, 123-45-6789) or only mark the break (confiden-tial), so
// `versions` holds the text as written and, when there are any, without the
// ones after a letter with a lowercase letter next; `at` takes each of a
// version's characters back to `text`. A gap as wide as a table column becomes
// a tab, so patterns that allow only spaces (the number presets) stay within a cell.
// Right-to-left lines (Arabic, Hebrew) come with their characters in the order
// the glyphs sit on the page, from the left; a search needs reading order.
// The positions in `order` say where each character of the line in reading
// order sits: runs of right-to-left characters, with the spaces and marks
// between them, are reversed; when right-to-left characters outnumber the
// others the whole line is too, with left-to-right runs (numbers, Latin
// words) turned back.
const RTL = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/;
const LTR = /[\p{L}\p{N}]/u;
export function readingOrder(text: string): number[] {
  // Per UTF-16 unit, as the callers index the text; a surrogate half counts as neutral.
  const kind = text.split("").map((ch) => (RTL.test(ch) ? "R" : LTR.test(ch) ? "L" : "N"));
  const order = kind.map((_, i) => i);
  if (!kind.includes("R")) return order;
  const rtl = kind.filter((k) => k === "R").length > kind.filter((k) => k === "L").length;
  // Maximal runs of `k`, neutrals inside them included.
  const flip = (seq: number[], k: string) => {
    const out = [...seq];
    for (let i = 0; i < out.length; ) {
      if (kind[out[i]] !== k) {
        i++;
        continue;
      }
      let j = i;
      for (let m = i + 1; m < out.length && kind[out[m]] !== (k === "R" ? "L" : "R"); m++) if (kind[out[m]] === k) j = m;
      out.splice(i, j - i + 1, ...out.slice(i, j + 1).reverse());
      i = j + 1;
    }
    return out;
  };
  return rtl ? flip([...order].reverse(), "L") : flip(order, "R");
}

export function searchText(p: PageText) {
  let text = "";
  const from: ([number, number, number] | null)[] = [];
  const soft = new Set<number>();
  p.lines.forEach((line, li) => {
    const drawn = lineChars(line.runs);
    const order = readingOrder(drawn.text);
    const chars = { text: order.map((i) => drawn.text[i]).join(""), from: order.map((i) => drawn.from[i]) };
    if (li > 0) {
      if (/[\p{L}\p{N}][-\u2010\u00ad]$/u.test(text) && /^[\p{L}\p{N}]/u.test(chars.text)) {
        if (/\p{L}.$/u.test(text) && /^\p{Ll}/u.test(chars.text)) soft.add(text.length - 1);
      } else {
        text += "\n";
        from.push(null);
      }
    }
    chars.from.forEach((f, j) => {
      let ch = chars.text[j];
      // A glyph its font maps to no text (a dot or joining piece of a shaped
      // script) reads as a control character; it isn't part of any word.
      if (/[\x00-\x08\x0e-\x1f]/.test(ch)) return;
      const [before, after] = [chars.from[j - 1], chars.from[j + 1]];
      if (!f && before && after && before[0] !== after[0]) {
        const a = line.runs[before[0]];
        const b = line.runs[after[0]];
        if (b.x - (a.x + a.w) > Math.max(b.size * 1.2, 9)) ch = "\t";
      }
      text += ch;
      from.push(f ? [li, f[0], f[1]] : null);
    });
  });
  const all = Array.from({ length: text.length }, (_, k) => k);
  const versions = [{ text, at: all }];
  if (soft.size) {
    const at = all.filter((k) => !soft.has(k));
    versions.push({ text: at.map((k) => text[k]).join(""), at });
  }
  return { text, from, versions };
}

const globally = (re: RegExp) => new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");

// Text matches → boxes in visual fractions, for the redaction editor. A match
// is found in the page's text, so it may span runs (a bold surname, a phrase
// split across text objects) and lines; it gets one box per line it covers.
// `hit` numbers the matches, `text` is what matched with whitespace as single spaces.
export function findMatches(pages: PageText[], pattern: RegExp): { page: number; rect: FracRect; text: string; hit: number }[] {
  const out: { page: number; rect: FracRect; text: string; hit: number }[] = [];
  const re = globally(pattern);
  let hit = 0;
  pages.forEach((p, pi) => {
    const { from, versions } = searchText(p);
    // Each match as the range of the text it covers (a hyphen left out
    // included); both versions find most of them.
    const found = new Map<string, [number, number, string]>();
    for (const v of versions) {
      for (const m of v.text.matchAll(re)) {
        if (!m[0]) continue;
        const [a, b] = [v.at[m.index], v.at[m.index + m[0].length - 1] + 1];
        if (!found.has(`${a}:${b}`)) found.set(`${a}:${b}`, [a, b, m[0]]);
      }
    }
    for (const [a, b, matched] of [...found.values()].sort((x, y) => x[0] - y[0] || x[1] - y[1])) {
      // The characters covered, as a range in each run of each line.
      const covered = new Map<number, Map<number, [number, number]>>();
      for (let k = a; k < b; k++) {
        const f = from[k];
        if (!f) continue;
        const [li, ri, i] = f;
        const runs = covered.get(li) ?? new Map<number, [number, number]>();
        const [lo, hi] = runs.get(ri) ?? [i, i];
        runs.set(ri, [Math.min(lo, i), Math.max(hi, i)]);
        covered.set(li, runs);
      }
      for (const [li, runs] of covered) {
        const line = p.lines[li];
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, size = 0;
        for (const [ri, [lo, hi]] of runs) {
          const run = line.runs[ri];
          const box = charBox(run, lo, hi + 1);
          x0 = Math.min(x0, box.x);
          y0 = Math.min(y0, box.y);
          x1 = Math.max(x1, box.x + box.w);
          y1 = Math.max(y1, box.y + box.h);
          size = Math.max(size, run.size);
        }
        const pad = size * 0.12;
        out.push({
          page: pi,
          hit,
          text: matched.replace(/\s+/g, " "),
          rect: { x: (x0 - pad) / p.width, y: (y0 - pad) / p.height, w: (x1 - x0 + pad * 2) / p.width, h: (y1 - y0 + pad * 2) / p.height },
        });
      }
      hit++;
    }
  });
  return out;
}

const overlaps = (a: FracRect, b: FracRect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

// True redaction: PDFium removes the text, image pixels and shapes under each
// box and draws the box in black; everything else stays as it was (real text,
// sharp vectors). Pages are then copied into a new file, which leaves behind
// bookmarks, attachments, scripts, form data and tags that could repeat the
// hidden text. A page PDFium can't handle falls back to being rendered as an
// image with the boxes burned in.
function userBoxes(page: PDFPage, rects: FracRect[]): Box[] {
  const { vw, vh, map } = visualFrame(page);
  return rects.map((r) => {
    const pts = [
      map(r.x * vw, (1 - r.y) * vh), map((r.x + r.w) * vw, (1 - r.y) * vh),
      map(r.x * vw, (1 - r.y - r.h) * vh), map((r.x + r.w) * vw, (1 - r.y - r.h) * vh),
    ];
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
  });
}

const name = (s: string) => PDFName.of(s);

// Links, notes and form fields under a box would still carry or point at what's
// hidden. Popups and replies belong to their note and go with it. This runs
// before the page is copied, so what goes is never copied at all.
function dropAnnotsUnder(page: PDFPage, boxes: Box[]) {
  const annots = page.node.lookupMaybe(name("Annots"), PDFArray);
  if (!annots) return;
  const ctx = page.doc.context;
  const refs = annots.asArray();
  const dicts = refs.map((ref) => {
    const a = ctx.lookup(ref);
    return a instanceof PDFDict ? a : null;
  });
  const under = (a: PDFDict) => {
    const rect = a.lookupMaybe(name("Rect"), PDFArray);
    if (!rect) return false;
    const [x0, y0, x1, y1] = rect.asArray().map((v) => (v instanceof PDFNumber ? v.asNumber() : 0));
    const r = { x0: Math.min(x0, x1), x1: Math.max(x0, x1), y0: Math.min(y0, y1), y1: Math.max(y0, y1) };
    return boxes.some((b) => r.x0 < b.x1 && b.x0 < r.x1 && r.y0 < b.y1 && b.y0 < r.y1);
  };
  const gone = new Set(dicts.filter((a): a is PDFDict => a !== null && under(a)));
  for (let grew = true; grew; ) {
    grew = false;
    for (const a of dicts) {
      if (!a || gone.has(a)) continue;
      const dictAt = (key: string) => {
        const o = a.lookup(name(key));
        return o instanceof PDFDict ? o : undefined;
      };
      const owner = dictAt("Parent") ?? dictAt("IRT");
      if (owner && gone.has(owner)) {
        gone.add(a);
        grew = true;
      }
    }
  }
  page.node.set(name("Annots"), ctx.obj(refs.filter((_, i) => !gone.has(dicts[i]!))));
}

// A page drawn as an image keeps nothing of the original. Set rather than
// removed, so nothing is inherited from the page tree either.
function blank(page: PDFPage) {
  const node = page.node;
  for (const key of node.keys()) if (key !== name("Type") && key !== name("Parent")) node.delete(key);
  node.set(name("MediaBox"), node.context.obj([0, 0, 1, 1]));
  node.set(name("CropBox"), node.context.obj([0, 0, 1, 1]));
  node.set(name("Resources"), node.context.obj({}));
  node.set(name("Rotate"), PDFNumber.of(0));
}

// Page data that could repeat what was hidden: a thumbnail, an editor's private
// copy of the page (Illustrator keeps the whole artwork there), page metadata,
// page scripts and article beads.
const PRIVATE = ["Thumb", "PieceInfo", "Metadata", "AA", "B", "StructParents"];

// Cuts what the copier would follow from the pages to anything they don't
// show: the page data above, link targets outside the page tree (a page that
// was never in it would come along hidden), replies and popups whose note is
// gone, and the form a widget belongs to. The output has no form, and a
// field's tree leads to every field in it, those under a box included.
// Done before copying, so none of it is copied at all.
function detach(doc: PDFDocument) {
  const pages = doc.getPages();
  const annots = new Set<PDFDict>();
  const list = (page: PDFPage) => (page.node.lookupMaybe(name("Annots"), PDFArray)?.asArray() ?? []).map((ref) => doc.context.lookup(ref));
  for (const page of pages) for (const a of list(page)) if (a instanceof PDFDict) annots.add(a);
  const refs = new Set(pages.map((p) => p.ref));
  const live = (o: unknown) => !(o instanceof PDFRef) || refs.has(o);
  const kept = (o: unknown) => o === undefined || annots.has(doc.context.lookup(o as PDFRef) as PDFDict);
  for (const page of pages) for (const key of PRIVATE) page.node.delete(name(key));
  for (const a of annots) {
    if (a.get(name("Subtype")) === name("Widget")) a.delete(name("Parent"));
    else if (!kept(a.get(name("Parent")))) a.delete(name("Parent"));
    for (const key of ["IRT", "Popup"]) if (!kept(a.get(name(key)))) a.delete(name(key));
    if (!live(a.get(name("P")))) a.delete(name("P"));
    // A destination may be a name or a string (a named destination) rather
    // than an array, so these are checked, not typed lookups that would throw.
    const dest = a.lookup(name("Dest"));
    if (dest instanceof PDFArray && !live(dest.get(0))) a.delete(name("Dest"));
    const action = a.lookup(name("A"));
    const target = action instanceof PDFDict ? action.lookup(name("D")) : undefined;
    if (target instanceof PDFArray && !live(target.get(0))) a.delete(name("A"));
  }
}

// A searched text the caller expects gone everywhere, and the search that
// found it (the text itself, in the same case, when there is none).
export type Term = { text: string; pattern?: RegExp };

export class RedactionLeakError extends Error {
  code = "redaction_leak";
}

// `terms` are texts the caller expects gone everywhere (every search hit was
// kept). If the same search finds one anywhere, every marked page is drawn as
// an image instead; if it still finds one (a note or form field outside the
// boxes), nothing is returned.
// `scanned`: pages read with OCR (searchable()), always drawn as images so
// nothing under a box survives in the picture, then read with OCR again to
// check that no searched text is left (`ocrLang`). The result carries a
// report of what was checked and removed.
export async function redact(
  file: File, marks: { page: number; rect: FracRect }[], o: { redactDpi: string; terms?: Term[]; scanned?: number[]; ocrLang?: string }, progress?: Progress,
): Promise<Output[]> {
  // The file as readers see it (what the editor showed), decrypted when it has only an owner password.
  const { bytes, doc: original } = await openForEdit(await bytesOf(file), file.name);
  const byPage = new Map<number, FracRect[]>();
  for (const m of marks) byPage.set(m.page, [...(byPage.get(m.page) ?? []), m.rect]);
  const boxes = new Map([...byPage].map(([i, rects]) => [i, userBoxes(original.getPage(i), rects)] as const));

  let pdfium: { bytes: Uint8Array; failed: number[] } | null = null;
  try {
    pdfium = await redactInPlace(bytes, boxes);
  } catch {
    // PDFium couldn't open or save the file: every marked page is rendered instead.
  }
  const terms = (o.terms ?? []).filter((t) => t.text.trim());
  const title = terms.some((t) => baseName(file.name).includes(t.text)) ? "" : baseName(file.name);
  const build = (raster: Set<number>) => assemble(bytes, pdfium?.bytes ?? null, byPage, boxes, raster, Number(o.redactDpi) / 72, title, progress);
  const scanned = (o.scanned ?? []).filter((i) => i < original.getPageCount());
  let out = await build(new Set([...(pdfium ? pdfium.failed : byPage.keys()), ...scanned]));
  if (terms.length && (await leftovers(out, terms)).length) {
    out = await build(new Set([...byPage.keys(), ...scanned]));
    if ((await leftovers(out, terms)).length) throw new RedactionLeakError();
  }
  // Pictures of text are read again: OCR must not find a searched text either.
  let ocrLeft: number | null = null;
  if (scanned.length && terms.length) {
    try {
      const { autoOcr } = await import("./ocr");
      const again = await autoOcr(new File([out as BlobPart], file.name), { ocrLang: o.ocrLang ?? "eng" });
      ocrLeft = again.pages ? (await leftovers(new Uint8Array(await again.file.arrayBuffer()), terms)).length : 0;
    } catch {
      /* OCR unavailable: the report says the pictures weren't read again */
    }
    if (ocrLeft) throw new RedactionLeakError();
  }
  const report: RedactReport = {
    kind: "redact", areas: marks.length, pages: byPage.size, terms: terms.length, textLeft: 0,
    ocrPages: scanned.length, ocrLeft, ...(await removedParts(bytes, out)),
  };
  return [{ name: `${baseName(file.name)}-redacted.pdf`, blob: pdfBlob(out), report }];
}

// What a redaction took out besides the boxes: annotations and attached
// files, and which document properties (and whether XMP metadata) went.
async function removedParts(before: Uint8Array, after: Uint8Array) {
  const facts = async (bytes: Uint8Array) => {
    const doc = await PDFDocument.load(bytes, { updateMetadata: false, ignoreEncryption: true, throwOnInvalidObject: false });
    let annots = 0, files = 0;
    for (const p of doc.getPages()) annots += p.node.lookupMaybe(name("Annots"), PDFArray)?.size() ?? 0;
    const count = (node: PDFDict | undefined, depth = 0): number => {
      if (!node || depth > 32) return 0;
      const names = node.lookupMaybe(name("Names"), PDFArray);
      const kids = node.lookupMaybe(name("Kids"), PDFArray);
      return (names ? Math.floor(names.size() / 2) : 0) + (kids?.asArray().reduce<number>((n, k) => n + count(doc.context.lookup(k) as PDFDict | undefined, depth + 1), 0) ?? 0);
    };
    files = count(doc.catalog.lookupMaybe(name("Names"), PDFDict)?.lookupMaybe(name("EmbeddedFiles"), PDFDict));
    const info = doc.context.lookup(doc.context.trailerInfo.Info);
    const props = info instanceof PDFDict ? info.keys().map((k) => k.decodeText()).filter((k) => ["Title", "Author", "Subject", "Keywords", "Creator"].includes(k)) : [];
    return { annots, files, props, xmp: doc.catalog.has(name("Metadata")) };
  };
  const [a, b] = await Promise.all([facts(before), facts(after)]);
  return {
    annots: Math.max(0, a.annots - b.annots),
    attachments: Math.max(0, a.files - b.files),
    metadata: [...a.props.filter((k) => !b.props.includes(k)), ...(a.xmp && !b.xmp ? ["XMP"] : [])],
  };
}

// Batch redaction: the editor's searches (typed text or presets) run again on
// another file, every match there is blacked out, and like redact() the
// matched texts must then be gone from the whole file.
// Scanned pages are read with OCR first (`ocrLang`), like the editor does.
export async function redactSearches(file: File, searches: (RegExp | Search)[], o: { redactDpi: string; ocrLang?: string }, progress?: Progress): Promise<Output[]> {
  const { file: readable, pages, scanned } = await searchable(file, o.ocrLang ?? "eng");
  const marks: { page: number; rect: FracRect }[] = [];
  const terms = new Map<string, Term>();
  for (const s of searches) {
    const search = s instanceof RegExp ? { pattern: s } : s;
    for (const h of searchMatches(pages, search)) {
      marks.push({ page: h.page, rect: h.rect });
      terms.set(`${search.pattern.source}\n${h.text}`, { text: h.text, pattern: search.pattern });
    }
  }
  // With no match the file still comes back rewritten, without its metadata, like every redaction.
  const out = await redact(readable, marks, { redactDpi: o.redactDpi, terms: [...terms.values()], scanned, ocrLang: o.ocrLang }, progress);
  return out.map((x) => ({ ...x, name: `${baseName(file.name)}-redacted.pdf` }));
}

// The file's text, page by page, for searching. Pages that are pictures of
// text (scans) are read with OCR first: `file` is then a copy with their
// words as invisible text, and `scanned` lists them, since a box on a picture
// only works when the page is drawn again as an image. Without OCR (offline,
// its engine not cached yet) scans just have no text to search.
export async function searchable(file: File, ocrLang: string, progress?: Progress): Promise<{ file: File; pages: PageText[]; scanned: number[] }> {
  const read = async (f: File) => {
    const doc = await openPdf(await bytesOf(f));
    try {
      return await documentText(doc);
    } finally {
      await closePdf(doc);
    }
  };
  const pages = await read(file);
  if (pages.every((p) => p.lines.length)) return { file, pages, scanned: [] };
  try {
    const { autoOcr } = await import("./ocr");
    const r = await autoOcr(file, { ocrLang }, progress);
    if (!r.pages) return { file, pages, scanned: [] };
    const after = await read(r.file);
    return { file: r.file, pages: after, scanned: after.flatMap((p, i) => (!pages[i].lines.length && p.lines.length ? [i] : [])) };
  } catch {
    return { file, pages, scanned: [] };
  }
}

// Builds the output: pages from `redacted` (PDFium's file; the original when
// there is none), and the pages in `raster` drawn as images from the original.
async function assemble(
  bytes: Uint8Array, redacted: Uint8Array | null, byPage: Map<number, FracRect[]>, boxes: Map<number, Box[]>,
  raster: Set<number>, scale: number, title: string, progress?: Progress,
) {
  const src = await PDFDocument.load(redacted ?? bytes, { updateMetadata: false });
  const count = src.getPageCount();
  for (const [i, b] of boxes) {
    if (raster.has(i)) blank(src.getPage(i));
    else dropAnnotsUnder(src.getPage(i), b);
  }
  detach(src);
  // One copier for every page, so a link to another page lands on that page's
  // copy rather than bringing along a hidden duplicate (the unredacted one, for
  // a page drawn as an image).
  const out = await PDFDocument.create();
  let done = 0;
  const tick = () => progress?.(++done, count);
  await src.flush();
  const copier = PDFObjectCopier.for(src.context, out.context);
  for (let i = 0; i < count; i++) {
    const ref = copier.copy(src.getPage(i).ref);
    out.addPage(PDFPage.of(out.context.lookup(ref) as PDFPageLeaf, ref, out));
    if (!raster.has(i)) tick();
  }

  const view = raster.size ? await openPdf(bytes) : null;
  for (const i of [...raster].sort((a, b) => a - b)) {
    const rects = byPage.get(i) ?? [];
    const page = await view!.getPage(i + 1);
    const v = page.getViewport({ scale: 1 });
    const canvas = await renderPage(page, scale);
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#000";
    for (const b of rects) ctx.fillRect(b.x * canvas.width, b.y * canvas.height, b.w * canvas.width, b.h * canvas.height);
    const jpg = await out.embedJpg(await bytesOf(await canvasToBlob(canvas, "image/jpeg", 0.9)));
    const p = out.getPage(i);
    for (const box of ["MediaBox", "CropBox"]) p.node.set(name(box), out.context.obj([0, 0, v.width, v.height]));
    p.drawImage(jpg, { x: 0, y: 0, width: v.width, height: v.height });
    const text = await pageText(page);
    // Word by word, so text beside a redaction stays searchable.
    const words = text.items.flatMap((r) => {
      if (!r.xs || r.xs.length !== r.text.length + 1) return [r];
      const out: typeof text.items = [];
      for (const m of r.text.matchAll(/\S+/g)) {
        const x0 = r.xs[m.index], x1 = r.xs[m.index + m[0].length];
        out.push({ ...r, text: m[0], x: x0, w: x1 - x0, xs: undefined });
      }
      return out;
    });
    const keep = words.filter((r) => !rects.some((b) => overlaps(b, { x: r.x / v.width, y: r.y / v.height, w: r.w / v.width, h: r.h / v.height })));
    addInvisibleText(out, p, runsToWords(keep, v.height));
    canvas.width = canvas.height = 0;
    page.cleanup();
    tick();
  }
  if (view) await closePdf(view);
  // Nothing from the original's metadata survives.
  out.setProducer("Nopload");
  out.setCreator("Nopload");
  if (title) out.setTitle(title);
  out.catalog.delete(name("Metadata"));
  // qpdf rewrites the file from what it still refers to, so nothing left over
  // from editing survives, and drops resources no page uses (an image wholly
  // under a box that PDFium took off the page). Without it, nothing is saved.
  return (await runQpdf(await out.save({ useObjectStreams: true }), (i, o) => ["--object-streams=generate", "--remove-unreferenced-resources=yes", i, o])).output;
}

// Texts from `terms` the same search still finds in the file: in any string
// (link targets, notes, form values), in XMP or attached files, or in the text
// of a page. The document information dictionary is redact()'s own: dates,
// the producer and a title it has checked.
export async function leftovers(bytes: Uint8Array, terms: Term[]): Promise<string[]> {
  const found = new Set<string>();
  // Each term's own search, run again: a whole-word search for "Ann" doesn't
  // count "Anna", and "ANN" is another text.
  const searches = terms.map((t) => [t.text, globally(t.pattern ?? searchPattern(t.text, { matchCase: true }))] as const);
  const check = (s: string) => {
    for (const [text, re] of searches)
      if (!found.has(text) && [...s.matchAll(re)].some((m) => m[0].replace(/\s+/g, " ") === text)) found.add(text);
  };
  const visit = (o: unknown): void => {
    if (o instanceof PDFString || o instanceof PDFHexString) {
      try {
        check(o.decodeText());
      } catch {
        check(o.asString());
      }
    } else if (o instanceof PDFDict) o.values().forEach(visit);
    else if (o instanceof PDFArray) o.asArray().forEach(visit);
  };
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const info = doc.context.trailerInfo.Info;
  for (const [ref, obj] of doc.context.enumerateIndirectObjects()) {
    if (ref === info) continue;
    if (!(obj instanceof PDFRawStream)) {
      visit(obj);
      continue;
    }
    visit(obj.dict);
    const kind = [obj.dict.get(name("Type")), obj.dict.get(name("Subtype"))].map(String).join(" ");
    if (!/Metadata|EmbeddedFile|XML/.test(kind)) continue;
    let data: Uint8Array;
    try {
      data = decodePDFRawStream(obj).decode();
    } catch {
      data = obj.contents;
    }
    check(new TextDecoder().decode(data));
    check(new TextDecoder("utf-16be").decode(data));
  }
  const pdf = await openPdf(bytes);
  try {
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const text = await pageText(page);
      for (const v of searchText(text).versions) check(v.text);
      // Each run on its own as well, apart from the next (table cells "44" and "71" aren't "4471").
      check(text.items.map((r) => r.text).join("\n"));
      page.cleanup();
    }
  } finally {
    await closePdf(pdf);
  }
  return [...found];
}

// Loads the code protect, unlock and redact load as they run (src/lib/offline.ts).
export const prepare = () => Promise.all([pdfjs(), prepareQpdf(), preparePdfium()]);
