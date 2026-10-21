// What the editor needs to know about form fields without loading pdf-lib:
// the kinds it can create, and the date formats a date field can ask for.

export const FIELD_KINDS = ["textField", "checkbox", "radio", "dropdown", "optionList", "dateField", "signatureField"] as const;
export type FieldKind = (typeof FIELD_KINDS)[number];
export const isFieldKind = (k: string): k is FieldKind => (FIELD_KINDS as readonly string[]).includes(k);
// Kinds whose options the user lists.
export const hasOptions = (k: string) => k === "radio" || k === "dropdown" || k === "optionList";

// ── Dates. Values are kept as typed in the field's format; the editor's
// date picker works in ISO (YYYY-MM-DD) and converts.
export const DATE_FORMATS = ["YYYY-MM-DD", "DD/MM/YYYY", "MM/DD/YYYY", "DD.MM.YYYY"] as const;
export type DateFormat = (typeof DATE_FORMATS)[number];

export function formatDate(iso: string, format: DateFormat): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  const [, y, mo, d] = m;
  return format.replace("YYYY", y).replace("MM", mo).replace("DD", d);
}

export function parseDate(text: string, format: DateFormat): string {
  const order = format.match(/YYYY|MM|DD/g)!;
  const parts = text.trim().match(/\d+/g);
  if (!parts || parts.length !== 3) return "";
  const v: Record<string, number> = {};
  order.forEach((k, i) => (v[k] = Number(parts[i])));
  const date = new Date(Date.UTC(v.YYYY, v.MM - 1, v.DD));
  if (v.YYYY < 1000 || date.getUTCMonth() !== v.MM - 1 || date.getUTCDate() !== v.DD) return "";
  return `${v.YYYY}-${String(v.MM).padStart(2, "0")}-${String(v.DD).padStart(2, "0")}`;
}

// The format a field's tooltip asks for, as dateTooltip writes it.
export function dateFormatOf(tooltip: string | undefined): DateFormat | undefined {
  const m = tooltip && /\(([YMD./-]{8,10})\)\s*$/.exec(tooltip);
  return m ? DATE_FORMATS.find((f) => f === m[1]) : undefined;
}
export const dateTooltip = (label: string | undefined, format: DateFormat) => `${label?.trim() || "Date"} (${format})`;
