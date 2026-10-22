// An in-browser PDF/A check, written from the ISO 19005 clauses. It covers
// the rules a converted file most often breaks, not the whole standard:
// veraPDF stays the reference, run in CI (tests/pdfa.mjs).
//
//   trailer    no encryption, and a file identifier     1: 6.1.3     2, 3: 6.1.3
//   intent     a PDF/A output intent with a profile     1: 6.2.2     2, 3: 6.2.3
//   fonts      every font that draws text is embedded   1: 6.3.4     2, 3: 6.2.11.4.1
//   actions    no JavaScript or other banned actions    1: 6.6.1     2, 3: 6.5.1
//   metadata   XMP metadata naming the part and level   1: 6.7.2     2, 3: 6.6.2.1
//              (pdfaid:part, pdfaid:conformance)        1: 6.7.11    2, 3: 6.6.4
//   transparency (level 1 only) none at all             1: 6.4
//
// The clause numbers are the ones veraPDF reports for the same rule.

import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFRawStream, PDFRef, PDFStream, decodePDFRawStream } from "pdf-lib";
import type { PdfaCheckReport } from "./common";

type Issue = PdfaCheckReport["issues"][number];
type Part = "1" | "2" | "3";

const CLAUSES: Record<"1" | "2", Record<string, string>> = {
  "1": { trailer: "6.1.3", intent: "6.2.2", fonts: "6.3.4", actions: "6.6.1", metadata: "6.7.2", pdfaid: "6.7.11", transparency: "6.4" },
  "2": { trailer: "6.1.3", intent: "6.2.3", fonts: "6.2.11.4.1", actions: "6.5.1", metadata: "6.6.2.1", pdfaid: "6.6.4" },
};

// Actions PDF/A forbids. Part 1 lists Launch, Sound, Movie, ResetForm,
// ImportData and JavaScript; parts 2 and 3 add Hide, SetOCGState, Rendition,
// Trans and GoTo3DView.
const BANNED_1 = ["Launch", "Sound", "Movie", "ResetForm", "ImportData", "JavaScript"];
const BANNED_2 = [...BANNED_1, "Hide", "SetOCGState", "Rendition", "Trans", "GoTo3DView"];

const N = (s: string) => PDFName.of(s);

export async function checkPdfa(bytes: Uint8Array, level: string): Promise<PdfaCheckReport> {
  const part = (level[0] === "1" ? "1" : level[0] === "3" ? "3" : "2") as Part;
  const clause = CLAUSES[part === "1" ? "1" : "2"];
  const issues: Issue[] = [];
  const fail = (rule: string, detail?: string) => issues.push({ rule, clause: clause[rule], ...(detail ? { detail } : {}) });

  const doc = await PDFDocument.load(bytes, { updateMetadata: false, ignoreEncryption: true, throwOnInvalidObject: false });
  const ctx = doc.context;
  const lookup = (o: unknown) => (o instanceof PDFRef ? ctx.lookup(o) : o);
  const dict = (o: unknown) => {
    const v = lookup(o);
    return v instanceof PDFDict ? v : v instanceof PDFStream ? v.dict : undefined;
  };

  // ── Trailer
  if (ctx.trailerInfo.Encrypt) fail("trailer", "Encrypt");
  if (!ctx.trailerInfo.ID) fail("trailer", "ID");

  // ── Output intent
  const intents = doc.catalog.lookupMaybe(N("OutputIntents"), PDFArray);
  const pdfaIntent = intents?.asArray().map(dict).find((d) => d?.get(N("S")) === N("GTS_PDFA1"));
  if (!pdfaIntent) fail("intent", "GTS_PDFA1");
  else if (!(lookup(pdfaIntent.get(N("DestOutputProfile"))) instanceof PDFStream)) fail("intent", "DestOutputProfile");

  // ── Metadata
  const meta = lookup(doc.catalog.get(N("Metadata")));
  if (!(meta instanceof PDFStream)) {
    fail("metadata", "Metadata");
    fail("pdfaid", "pdfaid:part");
  } else {
    let xml = "";
    try {
      xml = new TextDecoder().decode(meta instanceof PDFRawStream ? decodePDFRawStream(meta).decode() : meta.getContents());
    } catch {
      /* unreadable: no identification found below */
    }
    const field = (k: string) => xml.match(new RegExp(`pdfaid:${k}\\s*=\\s*["']([^"']*)["']`))?.[1] ?? xml.match(new RegExp(`<pdfaid:${k}>\\s*([^<\\s]*)\\s*<`))?.[1];
    const claimed = field("part");
    const conf = field("conformance");
    if (claimed !== level[0]) fail("pdfaid", `pdfaid:part ${claimed ?? "-"}`);
    else if ((conf ?? "").toLowerCase() !== level[1]) fail("pdfaid", `pdfaid:conformance ${conf ?? "-"}`);
  }

  // ── Every object once: actions, fonts and (level 1) transparency.
  const banned = part === "1" ? BANNED_1 : BANNED_2;
  const badActions = new Set<string>();
  const fonts = new Set<string>();
  const seenFont = new Set<PDFDict>();
  let transparent = "";
  const embedded = (font: PDFDict): boolean => {
    const sub = font.get(N("Subtype"));
    if (sub === N("Type3")) return true;
    if (sub === N("Type0")) {
      const kids = font.lookupMaybe(N("DescendantFonts"), PDFArray)?.asArray().map(dict) ?? [];
      return kids.length > 0 && kids.every((k) => !k || embedded(k));
    }
    const fd = dict(font.get(N("FontDescriptor")));
    return !!fd && ["FontFile", "FontFile2", "FontFile3"].some((k) => lookup(fd.get(N(k))) instanceof PDFStream);
  };
  const fontName = (font: PDFDict) => String(font.get(N("BaseFont")) ?? "").replace(/^\//, "") || "?";

  // Fonts and transparency count where a page, form, pattern, Type 3 glyph or
  // annotation appearance can use them: in a resource dictionary.
  const visited = new Set<PDFDict>();
  const resources = (res: PDFDict | undefined, depth = 0) => {
    if (!res || visited.has(res) || depth > 40) return;
    visited.add(res);
    const fontDict = dict(res.get(N("Font")));
    for (const [, ref] of fontDict?.entries() ?? []) {
      const f = dict(ref);
      if (!f || seenFont.has(f)) continue;
      seenFont.add(f);
      if (!embedded(f)) fonts.add(fontName(f));
      if (f.get(N("Subtype")) === N("Type3")) resources(dict(f.get(N("Resources"))), depth + 1);
    }
    if (part === "1") {
      for (const [, ref] of dict(res.get(N("ExtGState")))?.entries() ?? []) {
        const gs = dict(ref);
        if (!gs) continue;
        const smask = gs.get(N("SMask"));
        const alpha = (k: string) => {
          const v = lookup(gs.get(N(k)));
          return v instanceof PDFNumber && v.asNumber() !== 1;
        };
        const bm = gs.get(N("BM"));
        if ((smask && smask !== N("None")) || alpha("CA") || alpha("ca") || (bm && bm !== N("Normal") && bm !== N("Compatible"))) transparent ||= "ExtGState";
      }
    }
    for (const [, ref] of dict(res.get(N("XObject")))?.entries() ?? []) {
      const x = dict(ref);
      if (!x) continue;
      if (part === "1" && x.get(N("Subtype")) === N("Image") && x.has(N("SMask"))) transparent ||= "SMask";
      if (x.get(N("Subtype")) === N("Form")) {
        if (part === "1" && dict(x.get(N("Group")))?.get(N("S")) === N("Transparency")) transparent ||= "Group";
        resources(dict(x.get(N("Resources"))), depth + 1);
      }
    }
    for (const [, ref] of dict(res.get(N("Pattern")))?.entries() ?? []) resources(dict(dict(ref)?.get(N("Resources"))), depth + 1);
  };
  for (const page of doc.getPages()) {
    resources(page.node.Resources());
    if (part === "1" && dict(page.node.get(N("Group")))?.get(N("S")) === N("Transparency")) transparent ||= "Group";
    for (const a of page.node.lookupMaybe(N("Annots"), PDFArray)?.asArray().map(dict) ?? []) {
      const ap = dict(a?.get(N("AP")));
      for (const [, v] of ap?.entries() ?? []) {
        const s = lookup(v);
        if (s instanceof PDFStream) resources(dict(s.dict.get(N("Resources"))));
        else if (s instanceof PDFDict) for (const [, w] of s.entries()) resources(dict(dict(w)?.get(N("Resources"))));
      }
    }
  }
  // An action is any dictionary with an action type (/S) and an action key, wherever it is.
  for (const [, obj] of ctx.enumerateIndirectObjects()) {
    const walk = (o: unknown, depth: number) => {
      if (depth > 6) return;
      if (o instanceof PDFDict) {
        const s = o.get(N("S"));
        const type = o.get(N("Type"));
        // Structure elements name their role with /S too.
        if (s instanceof PDFName && banned.includes(s.decodeText()) && (!type || type === N("Action"))) badActions.add(s.decodeText());
        for (const [, v] of o.entries()) if (!(v instanceof PDFRef)) walk(v, depth + 1);
      } else if (o instanceof PDFArray) for (const v of o.asArray()) if (!(v instanceof PDFRef)) walk(v, depth + 1);
    };
    walk(obj instanceof PDFStream ? obj.dict : obj, 0);
  }
  if (dict(doc.catalog.get(N("Names")))?.has(N("JavaScript"))) badActions.add("JavaScript");
  if (doc.catalog.has(N("AA"))) badActions.add("AA");

  for (const a of badActions) fail("actions", a);
  for (const f of fonts) fail("fonts", f);
  if (transparent) fail("transparency", transparent);

  const checked = part === "1" ? 7 : 6;
  return { kind: "pdfa", level, checked, issues };
}
