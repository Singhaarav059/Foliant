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

export const fontFile = (family: Family, bold: boolean, italic: boolean) => `${family}-latin-${bold ? 700 : 400}-${italic ? "italic" : "normal"}.woff`;

// `base`: an absolute URL ending in /, so the rules also work in a blob: page.
export function fontFaces(base: string) {
  const rules: string[] = [];
  for (const [family, names] of ALIASES)
    for (const name of names)
      for (const bold of [false, true])
        for (const italic of [false, true])
          rules.push(`@font-face { font-family: "${name}"; font-weight: ${bold ? 700 : 400}; font-style: ${italic ? "italic" : "normal"}; src: local("${name}${bold ? " Bold" : ""}${italic ? " Italic" : ""}"), url("${base}${fontFile(family, bold, italic)}") format("woff"); }`);
  return rules.join("\n");
}

export const fontBase = () => `${typeof location === "undefined" ? "" : location.origin}${VENDOR}pdfa-fonts/`;
