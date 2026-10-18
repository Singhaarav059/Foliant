"use client";

// Form fields the editor creates (PDF forms): text fields, checkboxes, radio
// groups, dropdowns, lists, date fields and empty signature fields, built
// with pdf-lib (MIT). A date field is a text field whose tooltip names the
// format it expects; it carries no JavaScript format action. A signature
// field is an unsigned /Sig field with a plain box as its appearance, ready
// for a signing app (or Nopload's digital signatures) to fill.

import {
  PDFDocument, PDFPage, PDFFont, PDFForm, PDFName, PDFHexString, PDFField, PDFOptionList, StandardFonts, rgb, degrees,
} from "pdf-lib";
import { isWinAnsi } from "./common";
import { fontCovering } from "./fonts";
import { type DateFormat, type FieldKind, dateTooltip } from "./formsmeta";

export * from "./formsmeta";

export type FieldSpec = {
  kind: FieldKind;
  name?: string;
  options?: string[];
  required?: boolean;
  multiple?: boolean; // lists: more than one choice
  multiline?: boolean; // text fields
  dateFormat?: DateFormat;
  tooltip?: string; // the field's description (/TU), which viewers show and read out
};

// ── Names
export function uniqueName(form: PDFForm, base: string) {
  const names = new Set(form.getFields().map((f) => f.getName()));
  // pdf-lib reads a dot as a parent.child separator.
  const clean = base.trim().replace(/[.\s]+/g, "_") || "field";
  let n = clean;
  let k = 2;
  while (names.has(n)) n = `${clean}_${k++}`;
  return n;
}

// ── Fields

export type Frame = { map: (vx: number, vy: number) => [number, number]; rot: number };
// A box in visual points: bottom-left corner, width and height.
export type VisualBox = { vx: number; vy: number; w: number; h: number };

const BORDER = rgb(0.6, 0.64, 0.7);

// A font that can show all of `text` in a field's appearance: Helvetica when
// it can, else a bundled one. Null when none can (the viewer then draws it).
async function fieldFont(doc: PDFDocument, text: string, helvetica: PDFFont) {
  if (isWinAnsi(text)) return helvetica;
  return fontCovering(doc, text).catch(() => null);
}

export async function addField(doc: PDFDocument, form: PDFForm, page: PDFPage, frame: Frame, spec: FieldSpec, box: VisualBox) {
  const helvetica = await doc.embedFont(StandardFonts.Helvetica);
  const rotate = degrees(frame.rot);
  const at = (b: VisualBox) => {
    const [x, y] = frame.map(b.vx, b.vy);
    return { x, y, width: b.w, height: b.h, rotate };
  };
  // Text sized to the box, as pdf-lib's automatic size grows text past the
  // end of a short box. Lists show several lines, so theirs stays small.
  const fontSize = Math.max(7, Math.min(box.h * 0.55, 12));
  const unique = [...new Set((spec.options ?? []).map((o) => o.trim()).filter(Boolean))];
  const describe = (field: PDFField, text?: string) => {
    if (text?.trim()) field.acroField.dict.set(PDFName.of("TU"), PDFHexString.fromText(text.trim()));
    if (spec.required) field.enableRequired();
  };

  switch (spec.kind) {
    case "textField":
    case "dateField": {
      const field = form.createTextField(uniqueName(form, spec.name || (spec.kind === "dateField" ? "date" : "text")));
      if (spec.multiline) field.enableMultiline();
      field.addToPage(page, { ...at(box), borderColor: BORDER, borderWidth: 1 });
      field.setFontSize(spec.multiline ? Math.min(fontSize, 11) : fontSize);
      describe(field, spec.kind === "dateField" ? dateTooltip(spec.tooltip, spec.dateFormat ?? "YYYY-MM-DD") : spec.tooltip);
      return;
    }
    case "checkbox": {
      const field = form.createCheckBox(uniqueName(form, spec.name || "check"));
      field.addToPage(page, { ...at(box), borderColor: rgb(0.4, 0.44, 0.5), borderWidth: 1 });
      describe(field, spec.tooltip);
      return;
    }
    case "dropdown":
    case "optionList": {
      const font = await fieldFont(doc, unique.join(" "), helvetica);
      const field = spec.kind === "dropdown"
        ? form.createDropdown(uniqueName(form, spec.name || "dropdown"))
        : form.createOptionList(uniqueName(form, spec.name || "list"));
      field.setOptions(unique);
      if (field instanceof PDFOptionList && spec.multiple) field.enableMultiselect();
      try {
        field.addToPage(page, { ...at(box), borderColor: BORDER, borderWidth: 1, font: font ?? helvetica });
        field.setFontSize(field instanceof PDFOptionList ? 10 : fontSize);
      } catch {
        // No font covers the options: the widget is on the page without an
        // appearance, and the viewer draws it.
        form.acroForm.dict.set(PDFName.of("NeedAppearances"), doc.context.obj(true));
      }
      describe(field, spec.tooltip);
      return;
    }
    case "radio": {
      const field = form.createRadioGroup(uniqueName(form, spec.name || "choice"));
      // One button per option, stacked in the box, each with its label beside it.
      const row = box.h / Math.max(1, unique.length);
      const d = Math.min(row * 0.8, 14, box.w);
      const size = Math.max(6, Math.min(row * 0.62, 11));
      for (let i = 0; i < unique.length; i++) {
        const cy = box.vy + box.h - (i + 0.5) * row;
        field.addOptionToPage(unique[i], page, { ...at({ vx: box.vx, vy: cy - d / 2, w: d, h: d }), borderColor: rgb(0.4, 0.44, 0.5), borderWidth: 1 });
        const font = await fieldFont(doc, unique[i], helvetica);
        if (!font) continue;
        const [x, y] = frame.map(box.vx + d + size * 0.5, cy - size * 0.35);
        page.drawText(unique[i], { x, y, size, font, color: rgb(0.07, 0.09, 0.15), rotate });
      }
      describe(field, spec.tooltip);
      return;
    }
    case "signatureField": {
      const ctx = doc.context;
      const [x0, y0] = frame.map(box.vx, box.vy);
      const [x1, y1] = frame.map(box.vx + box.w, box.vy + box.h);
      const rect = [Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)];
      const [rw, rh] = [rect[2] - rect[0], rect[3] - rect[1]];
      // A thin frame, the same whichever way the page is turned.
      const ap = ctx.register(ctx.stream(`q 0.6 0.64 0.7 RG 1 w 0.5 0.5 ${(rw - 1).toFixed(2)} ${(rh - 1).toFixed(2)} re S Q`, {
        Type: "XObject", Subtype: "Form", BBox: [0, 0, rw, rh],
      }));
      const dict = ctx.obj({
        Type: "Annot", Subtype: "Widget", FT: "Sig", F: 4, Rect: rect, P: page.ref,
        T: PDFHexString.fromText(uniqueName(form, spec.name || "signature")),
        AP: { N: ap },
        ...(spec.required ? { Ff: 2 } : {}),
      });
      if (spec.tooltip?.trim()) dict.set(PDFName.of("TU"), PDFHexString.fromText(spec.tooltip.trim()));
      const ref = ctx.register(dict);
      form.acroForm.addField(ref);
      page.node.addAnnot(ref);
      return;
    }
  }
}
