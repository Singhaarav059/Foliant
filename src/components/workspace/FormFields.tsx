"use client";

// The PDF forms tool's field parts of the editor: how a new field starts out,
// how it looks on the page while it's edited, its settings in the side panel,
// and the inputs that fill in fields a PDF already has.

import { Check, ChevronDown, PenLine, WandSparkles, X } from "lucide-react";
import { useI18n } from "../I18n";
import type { EditorItem, FieldInfo } from "@/lib/pdf/edit";
import type { Suggestion } from "@/lib/pdf/formsdetect";
import { DATE_FORMATS, formatDate, hasOptions, parseDate, type DateFormat, type FieldKind } from "@/lib/pdf/formsmeta";

type T = ReturnType<typeof useI18n>["t"];
type Value = string | boolean | string[];

// How each kind of field is announced.
export const FIELD_LABELS: Record<FieldKind, string> = {
  textField: "ed.addTextField", checkbox: "ed.addCheckbox", radio: "ed.addRadio", dropdown: "ed.addDropdown",
  optionList: "ed.addList", dateField: "ed.addDate", signatureField: "ed.addSignatureField",
};

const NAMES: Record<FieldKind, string> = {
  textField: "field", checkbox: "check", radio: "choice", dropdown: "dropdown", optionList: "list", dateField: "date", signatureField: "signature",
};

// Name, options and description of a new field; `count` is how many of its kind there are already.
export function newField(kind: FieldKind, count: number, t: T): Partial<EditorItem> {
  const options = hasOptions(kind) ? [1, 2, 3].map((n) => t("ed.optionN", { n })) : undefined;
  return {
    name: `${NAMES[kind]}_${count + 1}`,
    options,
    dateFormat: kind === "dateField" ? "YYYY-MM-DD" : undefined,
    tooltip: kind === "dateField" ? t("ed.date") : kind === "signatureField" ? t("ed.signature") : undefined,
  };
}

// The size a field gets when placed with a click, as fractions of the page;
// `ratio` is the page's width over its height.
export function fieldSize(it: EditorItem, ratio: number) {
  switch (it.kind) {
    case "checkbox": return { w: 0.03, h: 0.03 * ratio };
    case "radio": return { w: 0.22, h: 0.028 * Math.max(1, it.options?.length ?? 3) };
    case "optionList": return { w: 0.3, h: 0.1 };
    case "dateField": return { w: 0.18, h: 0.035 };
    case "signatureField": return { w: 0.3, h: 0.07 };
    default: return { w: 0.3, h: 0.035 };
  }
}

export const fieldShape = (kind: FieldKind): React.CSSProperties =>
  kind === "checkbox" ? { border: "1.5px solid #4b5563", background: "#fff" }
  : kind === "radio" ? { background: "color-mix(in oklab, var(--accent) 6%, transparent)", border: "1px dashed var(--accent)" }
  : { background: "color-mix(in oklab, var(--accent) 12%, transparent)", border: "1px dashed var(--accent)" };

// What a field being edited shows on the page. `px` is points to pixels.
export function FieldPreview({ item, px }: { item: EditorItem; px: number }) {
  const { t } = useI18n();
  const options = (item.options ?? []).filter((o) => o.trim());
  const label = <span className="absolute left-1 top-0 text-[10px] text-accent">{item.name}{item.required ? " *" : ""}</span>;
  if (item.kind === "radio") {
    return (
      <div className="flex h-full flex-col text-black">
        {options.map((o, i) => (
          <div key={i} className="flex min-h-0 flex-1 items-center gap-1 overflow-hidden" style={{ fontSize: Math.max(7, Math.min(11 * px, 13)) }}>
            <span className="aspect-square h-[70%] max-h-[14px] shrink-0 rounded-full border border-[#4b5563] bg-white" />
            <span className="truncate">{o}</span>
          </div>
        ))}
      </div>
    );
  }
  if (item.kind === "dropdown") {
    return <>{label}<span className="absolute inset-y-0 left-1 flex items-end pb-0.5 text-[11px] text-black/70">{options[0]}</span><ChevronDown size={14} className="absolute right-1 top-1/2 -translate-y-1/2 text-accent" /></>;
  }
  if (item.kind === "optionList") {
    return <>{label}<div className="h-full overflow-hidden px-1 pt-3 text-[10px] leading-tight text-black/70">{options.map((o, i) => <div key={i} className="truncate">{o}</div>)}</div></>;
  }
  if (item.kind === "dateField") return <>{label}<span className="absolute bottom-0.5 left-1 text-[10px] text-black/45">{item.dateFormat ?? "YYYY-MM-DD"}</span></>;
  if (item.kind === "signatureField") {
    return <>{label}<span className="absolute inset-0 flex items-center justify-center gap-1 text-[12px] text-accent"><PenLine size={14} /> {t("ed.signHere")}</span></>;
  }
  if (item.kind === "textField") return label;
  return null;
}

// The selected field's settings.
export function FieldSettings({ item, onChange }: { item: EditorItem; onChange: (p: Partial<EditorItem>) => void }) {
  const { t } = useI18n();
  const check = (key: "required" | "multiple" | "multiline", label: string) => (
    <label className="flex items-center gap-2 text-[13px] text-ink-2">
      <input type="checkbox" className="accent-[var(--accent)]" checked={Boolean(item[key])} onChange={(e) => onChange({ [key]: e.target.checked })} />
      {label}
    </label>
  );
  return (
    <div className="space-y-3">
      <label className="block">
        <span className="mb-1 block text-[13px] text-muted">{t("ed.fieldName")}</span>
        <input className="field h-9" aria-label={t("ed.fieldName")} value={item.name ?? ""} onChange={(e) => onChange({ name: e.target.value })} />
      </label>
      {hasOptions(item.kind) && (
        <label className="block">
          <span className="mb-1 block text-[13px] text-muted">{t("ed.fieldOptions")}</span>
          <textarea className="field" rows={4} aria-label={t("ed.fieldOptions")} value={(item.options ?? []).join("\n")} onChange={(e) => onChange({ options: e.target.value.split("\n") })} />
        </label>
      )}
      {item.kind === "dateField" && (
        <label className="block">
          <span className="mb-1 block text-[13px] text-muted">{t("ed.fieldDateFormat")}</span>
          <select className="field h-9" aria-label={t("ed.fieldDateFormat")} value={item.dateFormat ?? "YYYY-MM-DD"} onChange={(e) => onChange({ dateFormat: e.target.value as DateFormat })}>
            {DATE_FORMATS.map((f) => <option key={f} value={f}>{f}</option>)}
          </select>
        </label>
      )}
      {item.kind === "optionList" && check("multiple", t("ed.fieldMultiple"))}
      {item.kind === "textField" && check("multiline", t("ed.fieldMultiline"))}
      {check("required", t("ed.fieldRequired"))}
    </div>
  );
}

// Fills in one field the PDF already has, in the side list.
export function FieldInput({ field, value, onChange }: { field: FieldInfo; value: Value | undefined; onChange: (v: Value) => void }) {
  const { t } = useI18n();
  const text = String(value ?? "");
  const name = field.name;
  switch (field.type) {
    case "checkbox":
      return <input type="checkbox" aria-label={name} className="h-5 w-5 accent-[var(--accent)]" checked={Boolean(value)} onChange={(e) => onChange(e.target.checked)} />;
    case "dropdown":
    case "radio":
      return (
        <select aria-label={name} className="field" value={text} onChange={(e) => onChange(e.target.value)}>
          <option value="" />
          {field.options?.map((o) => <option key={o}>{o}</option>)}
        </select>
      );
    case "list":
      return (
        <select multiple aria-label={name} className="field h-24" value={(value as string[]) ?? []} onChange={(e) => onChange(Array.from(e.target.selectedOptions, (o) => o.value))}>
          {field.options?.map((o) => <option key={o}>{o}</option>)}
        </select>
      );
    case "date": {
      // A value the format can't read is kept as text, so nothing typed elsewhere is lost.
      const iso = parseDate(text, field.dateFormat!);
      if (text && !iso) return <input aria-label={name} className="field" value={text} onChange={(e) => onChange(e.target.value)} />;
      return <input type="date" aria-label={name} className="field" value={iso} onChange={(e) => onChange(e.target.value ? formatDate(e.target.value, field.dateFormat!) : "")} />;
    }
    case "signature":
      return <p className="text-[13px] text-muted">{t("ed.signatureFieldNote")}</p>;
    case "text":
      return field.multiline
        ? <textarea aria-label={name} className="field" rows={3} value={text} onChange={(e) => onChange(e.target.value)} />
        : <input aria-label={name} className="field" value={text} onChange={(e) => onChange(e.target.value)} />;
    default:
      return null;
  }
}

// ── Detected fields

// Detection in the side panel: the button, what it found, and accept or reject all.
export function DetectPanel({ state, left, onDetect, onAcceptAll, onRejectAll }: {
  state: null | "busy" | number; left: number;
  onDetect: () => void; onAcceptAll: () => void; onRejectAll: () => void;
}) {
  const { t } = useI18n();
  return (
    <div className="space-y-2">
      <button className="btn btn-quiet w-full justify-start" disabled={state === "busy"} onClick={onDetect}>
        <WandSparkles size={18} /> {t("ed.detectFields")}
      </button>
      <p className="text-[13px] text-muted" aria-live="polite">
        {state === "busy" ? t("ed.detecting") : state === 0 ? t("ed.detectNone") : typeof state === "number" ? t("ed.detectFound", { n: state }) : t("ed.detectHint")}
      </p>
      {left > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[13px] text-ink-2">{t("ed.suggestionsLeft", { n: left })}</span>
          <button className="btn btn-quiet btn-sm" onClick={onAcceptAll}><Check size={15} /> {t("ed.acceptAll")}</button>
          <button className="btn btn-quiet btn-sm" onClick={onRejectAll}><X size={15} /> {t("ed.rejectAll")}</button>
        </div>
      )}
    </div>
  );
}

// A suggested field on the page, with buttons to accept or reject it.
export function SuggestionBox({ s, onAccept, onReject }: { s: Suggestion; onAccept: () => void; onReject: () => void }) {
  const { t } = useI18n();
  const label = s.label || t(FIELD_LABELS[s.kind]);
  const stop = (e: React.PointerEvent) => e.stopPropagation();
  return (
    <div data-suggestion={s.kind} className="absolute rounded-sm border border-dashed border-[#d97706] bg-[#f59e0b]/15"
      style={{ left: `${s.x * 100}%`, top: `${s.y * 100}%`, width: `${s.w * 100}%`, height: `${s.h * 100}%` }} onPointerDown={stop}>
      <span className="absolute bottom-full left-0 mb-0.5 flex items-center gap-0.5 whitespace-nowrap rounded bg-[#fffbeb] px-1 text-[10px] leading-4 text-[#92400e] shadow-sm">
        {s.kind !== "checkbox" && <span className="max-w-[12rem] truncate pe-0.5">{label}</span>}
        <button className="grid h-4 w-4 place-items-center rounded hover:bg-[#fde68a]" aria-label={t("ed.acceptSuggestion", { label })} title={t("ed.acceptSuggestion", { label })} onClick={onAccept}><Check size={12} /></button>
        <button className="grid h-4 w-4 place-items-center rounded hover:bg-[#fde68a]" aria-label={t("ed.rejectSuggestion", { label })} title={t("ed.rejectSuggestion", { label })} onClick={onReject}><X size={12} /></button>
      </span>
    </div>
  );
}
