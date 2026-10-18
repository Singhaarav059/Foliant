// Office fonts most devices lack (Calibri, Cambria, Arial on Android…) as
// @font-face rules for their metric-compatible stand-ins, which
// scripts/vendor.mjs copies to /vendor/<hash>/pdfa-fonts. A page laid out
// with these breaks lines and pages as Word does, and topdf.ts embeds the
// same files, so the PDF matches the layout. An installed font wins (local()).

import { VENDOR } from "../vendor";

export type Family = "carlito" | "caladea" | "arimo" | "tinos" | "cousine";

const ALIASES: [Family, string[]][] = [
  ["carlito", ["Calibri", "Calibri Light", "Carlito"]],
  ["caladea", ["Cambria", "Caladea"]],
  ["arimo", ["Arial", "Helvetica", "Arimo", "Liberation Sans"]],
  ["tinos", ["Times New Roman", "Times", "Tinos", "Liberation Serif"]],
  ["cousine", ["Courier New", "Courier", "Cousine", "Liberation Mono"]],
];

// Each face comes in fontsource's subsets, so Polish, Czech, Turkish,
// Vietnamese, Cyrillic and Greek text keeps the document's font. A browser
// fetches a subset only when the page has a character in its unicode-range,
// and topdf.ts embeds the subset that has the glyph (subsetFor). Caladea has
// Latin only. Keep in step with scripts/vendor.mjs.
const RANGES = {
  latin: "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD",
  "latin-ext": "U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF",
  vietnamese: "U+0102-0103,U+0110-0111,U+0128-0129,U+0168-0169,U+01A0-01A1,U+01AF-01B0,U+0300-0301,U+0303-0304,U+0308-0309,U+0323,U+0329,U+1EA0-1EF9,U+20AB",
  cyrillic: "U+0301,U+0400-045F,U+0490-0491,U+04B0-04B1,U+2116",
  "cyrillic-ext": "U+0460-052F,U+1C80-1C8A,U+20B4,U+2DE0-2DFF,U+A640-A69F,U+FE2E-FE2F",
  greek: "U+0370-0377,U+037A-037F,U+0384-038A,U+038C,U+038E-03A1,U+03A3-03FF",
  "greek-ext": "U+1F00-1FFF",
};
export type Subset = keyof typeof RANGES;
const ALL_SUBSETS = Object.keys(RANGES) as Subset[];
export const subsetsOf = (family: Family): Subset[] => (family === "caladea" ? ["latin", "latin-ext"] : ALL_SUBSETS);

const parsed = new Map<Subset, number[]>();
const rangesOf = (subset: Subset) => {
  let r = parsed.get(subset);
  if (!r) {
    r = RANGES[subset].split(",").flatMap((part) => {
      const [a, b = a] = part.slice(2).split("-");
      return [parseInt(a, 16), parseInt(b, 16)];
    });
    parsed.set(subset, r);
  }
  return r;
};
export function inSubset(subset: Subset, cp: number) {
  const r = rangesOf(subset);
  for (let i = 0; i < r.length; i += 2) if (cp >= r[i] && cp <= r[i + 1]) return true;
  return false;
}

export const fontFile = (family: Family, bold: boolean, italic: boolean, subset: Subset = "latin") => `${family}-${subset}-${bold ? 700 : 400}-${italic ? "italic" : "normal"}.woff`;

// `base`: an absolute URL ending in /, so the rules also work in a blob: page.
// `text`, when known, limits the rules to the subsets it has characters in
// (Latin always): WebKit can leave document.fonts loading for good over
// subsets the page never uses.
export function fontFaces(base: string, text?: string) {
  const used = new Set<Subset>(["latin"]);
  if (text === undefined) ALL_SUBSETS.forEach((s) => used.add(s));
  else for (const ch of new Set(text.replace(/[\x00-\x7f]+/g, ""))) for (const s of ALL_SUBSETS) if (inSubset(s, ch.codePointAt(0)!)) used.add(s);
  const rules: string[] = [];
  for (const [family, names] of ALIASES)
    for (const name of names)
      for (const bold of [false, true])
        for (const italic of [false, true])
          for (const subset of subsetsOf(family).filter((s) => used.has(s)))
            rules.push(`@font-face { font-family: "${name}"; font-weight: ${bold ? 700 : 400}; font-style: ${italic ? "italic" : "normal"}; src: local("${name}${bold ? " Bold" : ""}${italic ? " Italic" : ""}"), url("${base}${fontFile(family, bold, italic, subset)}") format("woff"); unicode-range: ${RANGES[subset]}; }`);
  return rules.join("\n");
}

export const fontBase = () => `${typeof location === "undefined" ? "" : location.origin}${VENDOR}pdfa-fonts/`;
