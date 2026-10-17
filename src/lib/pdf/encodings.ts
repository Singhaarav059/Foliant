// Character codes → Unicode for simple fonts, enough for PDF/A font
// substitution (pdfa.ts): WinAnsiEncoding, StandardEncoding and the Adobe
// Glyph List names those encodings use. Tables follow ISO 32000-1 Annex D.

const ASCII_NAMES = [
  "space", "exclam", "quotedbl", "numbersign", "dollar", "percent", "ampersand", "quotesingle", "parenleft", "parenright",
  "asterisk", "plus", "comma", "hyphen", "period", "slash", "zero", "one", "two", "three", "four", "five", "six", "seven",
  "eight", "nine", "colon", "semicolon", "less", "equal", "greater", "question", "at",
  ..."ABCDEFGHIJKLMNOPQRSTUVWXYZ",
  "bracketleft", "backslash", "bracketright", "asciicircum", "underscore", "grave",
  ..."abcdefghijklmnopqrstuvwxyz",
  "braceleft", "bar", "braceright", "asciitilde",
]; // 0x20–0x7E

const LATIN1_NAMES = [
  "space", "exclamdown", "cent", "sterling", "currency", "yen", "brokenbar", "section", "dieresis", "copyright", "ordfeminine",
  "guillemotleft", "logicalnot", "hyphen", "registered", "macron", "degree", "plusminus", "twosuperior", "threesuperior", "acute",
  "mu", "paragraph", "periodcentered", "cedilla", "onesuperior", "ordmasculine", "guillemotright", "onequarter", "onehalf",
  "threequarters", "questiondown", "Agrave", "Aacute", "Acircumflex", "Atilde", "Adieresis", "Aring", "AE", "Ccedilla", "Egrave",
  "Eacute", "Ecircumflex", "Edieresis", "Igrave", "Iacute", "Icircumflex", "Idieresis", "Eth", "Ntilde", "Ograve", "Oacute",
  "Ocircumflex", "Otilde", "Odieresis", "multiply", "Oslash", "Ugrave", "Uacute", "Ucircumflex", "Udieresis", "Yacute", "Thorn",
  "germandbls", "agrave", "aacute", "acircumflex", "atilde", "adieresis", "aring", "ae", "ccedilla", "egrave", "eacute",
  "ecircumflex", "edieresis", "igrave", "iacute", "icircumflex", "idieresis", "eth", "ntilde", "ograve", "oacute", "ocircumflex",
  "otilde", "odieresis", "divide", "oslash", "ugrave", "uacute", "ucircumflex", "udieresis", "yacute", "thorn", "ydieresis",
]; // 0xA0–0xFF

// WinAnsi 0x80–0x9F: [code, name, unicode].
const WIN_EXTRA: [number, string, number][] = [
  [0x80, "Euro", 0x20ac], [0x82, "quotesinglbase", 0x201a], [0x83, "florin", 0x0192], [0x84, "quotedblbase", 0x201e],
  [0x85, "ellipsis", 0x2026], [0x86, "dagger", 0x2020], [0x87, "daggerdbl", 0x2021], [0x88, "circumflex", 0x02c6],
  [0x89, "perthousand", 0x2030], [0x8a, "Scaron", 0x0160], [0x8b, "guilsinglleft", 0x2039], [0x8c, "OE", 0x0152],
  [0x8e, "Zcaron", 0x017d], [0x91, "quoteleft", 0x2018], [0x92, "quoteright", 0x2019], [0x93, "quotedblleft", 0x201c],
  [0x94, "quotedblright", 0x201d], [0x95, "bullet", 0x2022], [0x96, "endash", 0x2013], [0x97, "emdash", 0x2014],
  [0x98, "tilde", 0x02dc], [0x99, "trademark", 0x2122], [0x9a, "scaron", 0x0161], [0x9b, "guilsinglright", 0x203a],
  [0x9c, "oe", 0x0153], [0x9e, "zcaron", 0x017e], [0x9f, "Ydieresis", 0x0178],
];

// Glyph names → Unicode for every name above, plus the extras StandardEncoding uses.
export const GLYPHS = new Map<string, number>();
ASCII_NAMES.forEach((n, i) => GLYPHS.set(n, 0x20 + i));
LATIN1_NAMES.forEach((n, i) => { if (i) GLYPHS.set(n, 0xa0 + i); });
for (const [, n, u] of WIN_EXTRA) GLYPHS.set(n, u);
for (const [n, u] of [
  ["fraction", 0x2044], ["fi", 0xfb01], ["fl", 0xfb02], ["dotlessi", 0x0131], ["Lslash", 0x0141], ["lslash", 0x0142],
  ["breve", 0x02d8], ["dotaccent", 0x02d9], ["ring", 0x02da], ["ogonek", 0x02db], ["caron", 0x02c7], ["hungarumlaut", 0x02dd],
  ["minus", 0x2212], ["nbspace", 0x00a0], ["sfthyphen", 0x00ad], ["periodcentered", 0x00b7],
] as [string, number][]) GLYPHS.set(n, u);

export type Encoding = (string | undefined)[]; // code → glyph name

export const WIN_ANSI: Encoding = (() => {
  const e: Encoding = new Array(256);
  ASCII_NAMES.forEach((n, i) => (e[0x20 + i] = n));
  LATIN1_NAMES.forEach((n, i) => (e[0xa0 + i] = n));
  for (const [c, n] of WIN_EXTRA) e[c] = n;
  e[0x7f] = "bullet"; // undefined codes print as bullets in WinAnsi (Annex D note)
  return e;
})();

export const STANDARD: Encoding = (() => {
  const e: Encoding = new Array(256);
  ASCII_NAMES.forEach((n, i) => (e[0x20 + i] = n));
  e[0x27] = "quoteright";
  e[0x60] = "quoteleft";
  const high: [number, string][] = [
    [0xa1, "exclamdown"], [0xa2, "cent"], [0xa3, "sterling"], [0xa4, "fraction"], [0xa5, "yen"], [0xa6, "florin"], [0xa7, "section"],
    [0xa8, "currency"], [0xa9, "quotesingle"], [0xaa, "quotedblleft"], [0xab, "guillemotleft"], [0xac, "guilsinglleft"],
    [0xad, "guilsinglright"], [0xae, "fi"], [0xaf, "fl"], [0xb1, "endash"], [0xb2, "dagger"], [0xb3, "daggerdbl"],
    [0xb4, "periodcentered"], [0xb6, "paragraph"], [0xb7, "bullet"], [0xb8, "quotesinglbase"], [0xb9, "quotedblbase"],
    [0xba, "quotedblright"], [0xbb, "guillemotright"], [0xbc, "ellipsis"], [0xbd, "perthousand"], [0xbf, "questiondown"],
    [0xc1, "grave"], [0xc2, "acute"], [0xc3, "circumflex"], [0xc4, "tilde"], [0xc5, "macron"], [0xc6, "breve"], [0xc7, "dotaccent"],
    [0xc8, "dieresis"], [0xca, "ring"], [0xcb, "cedilla"], [0xcd, "hungarumlaut"], [0xce, "ogonek"], [0xcf, "caron"], [0xd0, "emdash"],
    [0xe1, "AE"], [0xe3, "ordfeminine"], [0xe8, "Lslash"], [0xe9, "Oslash"], [0xea, "OE"], [0xeb, "ordmasculine"], [0xf1, "ae"],
    [0xf5, "dotlessi"], [0xf8, "lslash"], [0xf9, "oslash"], [0xfa, "oe"], [0xfb, "germandbls"],
  ];
  for (const [c, n] of high) e[c] = n;
  return e;
})();

// Unicode for a glyph name: AGL names, uniXXXX and uXXXX[XX].
export function unicodeOf(name: string | undefined): number | undefined {
  if (!name) return undefined;
  const known = GLYPHS.get(name);
  if (known !== undefined) return known;
  const m = name.match(/^uni([0-9A-F]{4})$/) ?? name.match(/^u([0-9A-F]{4,6})$/);
  return m ? parseInt(m[1], 16) : undefined;
}
