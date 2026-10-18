"use client";

// The OCR language picker: a searchable list of every language, of which
// up to `max` can be ticked. The value is the ticked codes joined with "+".
// The choice is remembered on this device for the next document: with
// `restore` (the workspace), a fresh picker starts from it. A workflow step
// keeps the language it was saved with.

import { useEffect, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";
import { useI18n } from "../I18n";
import { ocrLangName, ocrLangs, rememberedOcrLang, rememberOcrLang } from "@/lib/ocr-langs";

export function LangPicker({
  id, choices, max, value, fallback, restore = false, onChange,
}: { id: string; choices: string[]; max: number; value: string; fallback: string; restore?: boolean; onChange: (v: string) => void }) {
  const { t, locale } = useI18n();
  const [query, setQuery] = useState("");
  const picked = ocrLangs(value, choices);

  // Names in the page's language and in their own, sorted for this language.
  const langs = useMemo(() => {
    const collator = new Intl.Collator(locale);
    return choices
      .map((code) => {
        const { name, native, tag, variant } = ocrLangName(code, locale);
        const label = variant ? t(`ocr.variant.${variant}`, { lang: name }) : name;
        return { code, tag, label, native: native !== name ? native : "" };
      })
      .sort((a, b) => collator.compare(a.label, b.label));
  }, [choices, locale, t]);
  const byCode = useMemo(() => new Map(langs.map((l) => [l.code, l])), [langs]);

  // A fresh document starts from the last choice.
  const restored = useRef(false);
  useEffect(() => {
    if (!restore || restored.current) return;
    restored.current = true;
    const saved = rememberedOcrLang();
    if (saved && value === fallback) {
      const v = ocrLangs(saved, choices).join("+");
      if (v !== value) onChange(v);
    }
  }, [choices, fallback, onChange, restore, value]);

  const set = (codes: string[]) => {
    const v = codes.join("+");
    rememberOcrLang(v);
    onChange(v);
  };
  const toggle = (code: string) =>
    set(picked.includes(code) ? picked.filter((c) => c !== code) : [...picked, code]);

  const q = query.trim().toLocaleLowerCase(locale);
  const shown = q
    ? langs.filter((l) => l.label.toLocaleLowerCase(locale).includes(q) || l.native.toLocaleLowerCase().includes(q) || l.code.startsWith(q))
    : langs;
  const full = picked.length >= max;

  return (
    <div>
      <ul className="mb-2 flex flex-wrap gap-1.5" aria-live="polite">
        {picked.map((code) => (
          <li key={code} className="inline-flex items-center gap-1 rounded-full border border-brand bg-[color-mix(in_oklab,var(--brand)_8%,var(--surface))] py-0.5 ps-3 pe-1 text-[13px] text-ink">
            {byCode.get(code)?.label ?? code}
            {picked.length > 1 && (
              <button
                type="button"
                className="grid h-7 w-7 place-items-center rounded-full text-muted hover:text-ink"
                aria-label={t("ocr.remove", { lang: byCode.get(code)?.label ?? code })}
                onClick={() => toggle(code)}
              >
                <X size={14} />
              </button>
            )}
          </li>
        ))}
      </ul>
      <input
        id={id}
        type="search"
        className="field"
        placeholder={t("ocr.search")}
        value={query}
        autoComplete="off"
        onChange={(e) => setQuery(e.target.value)}
      />
      <div role="group" aria-labelledby={`${id}-label`} className="mt-1.5 max-h-56 overflow-y-auto rounded-lg border border-line">
        {shown.map((l) => {
          const on = picked.includes(l.code);
          // The last language can't be unticked: OCR needs one.
          const disabled = on ? picked.length === 1 : full;
          return (
            <label
              key={l.code}
              className={`flex items-baseline gap-2 px-3 py-2 text-[14px] ${disabled && !on ? "text-muted" : "cursor-pointer text-ink-2 hover:bg-[color-mix(in_oklab,var(--ink)_4%,transparent)]"}`}
            >
              <input type="checkbox" className="translate-y-0.5 accent-[var(--brand)]" checked={on} disabled={disabled} onChange={() => toggle(l.code)} />
              <span className={on ? "font-medium text-ink" : undefined}>{l.label}</span>
              {l.native && <span lang={l.tag} className="truncate text-[13px] text-muted">{l.native}</span>}
            </label>
          );
        })}
        {!shown.length && <p className="px-3 py-2 text-[14px] text-muted">{t("ocr.none")}</p>}
      </div>
      <p className="mt-1.5 text-[13px] text-muted">{t("ocr.limit", { n: max })}</p>
    </div>
  );
}
