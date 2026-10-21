"use client";

import { useId, useRef, useState } from "react";
import { Eye, EyeOff, ImagePlus, Sparkles, X } from "lucide-react";
import { passwordStrength, suggestPassword } from "@/lib/pdf/password";
import { useI18n } from "../I18n";
import { optionVisible, type OptionDef } from "@/lib/tools";
import { LangPicker } from "./LangPicker";
import { LOCALES } from "@/lib/i18n/locales";

export function Options({
  defs, values, onChange, restore = false,
}: { defs: OptionDef[]; values: Record<string, unknown>; onChange: (key: string, value: unknown) => void; restore?: boolean }) {
  const { t, tOr } = useI18n();
  const uid = useId();
  const visible = defs.filter((d) => optionVisible(d, values, defs));
  if (!visible.length) return null;

  return (
    <div className="space-y-5">
      {visible.map((d) => {
        const id = `${uid}-${d.key}`;
        const label = t(`opt.${d.key}`);
        const value = values[d.key];
        if (d.type === "toggle") {
          return (
            <label key={d.key} htmlFor={id} className="flex cursor-pointer items-center justify-between gap-4">
              <span className="text-[14px] text-ink-2">{label}</span>
              <span className="relative inline-flex shrink-0">
                <input id={id} type="checkbox" className="peer sr-only" checked={Boolean(value)} onChange={(e) => onChange(d.key, e.target.checked)} />
                <span className="h-6 w-11 rounded-full bg-line-strong transition-colors peer-checked:bg-brand peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-[var(--focus)]" />
                <span className="absolute start-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow-[0_1px_2px_rgb(0_0_0/0.2)] transition-[transform,background-color] duration-200 peer-checked:translate-x-5 peer-checked:bg-brand-ink rtl:peer-checked:-translate-x-5" />
              </span>
            </label>
          );
        }
        return (
          <div key={d.key}>
            <label id={`${id}-label`} htmlFor={id} className="mb-1.5 flex items-baseline justify-between text-[13px] font-medium text-ink-2">
              {label}
              {d.type === "range" && <span className="tabular font-normal text-muted">{String(value)}{d.unit}</span>}
            </label>
            {d.type === "select" && (
              d.choices.length <= 3 && d.choices.every((c) => (t(`choice.${d.key}.${c}`)).length < 60) && !["dpi", "pdfaDpi", "redactDpi", "rotation", "screenWidth"].includes(d.key) ? (
                <div role="radiogroup" className="grid gap-1.5">
                  {d.choices.map((c) => {
                    const on = value === c;
                    // "Title: description". Chinese and Japanese strings use the fullwidth colon.
                    const full = tOr(`choice.${d.key}.${c}`, c);
                    const cut = full.search(/[:：]/);
                    const title = cut < 0 ? full : full.slice(0, cut);
                    const desc = cut < 0 ? "" : full.slice(cut + 1).trim();
                    return (
                      <button
                        key={c}
                        role="radio"
                        aria-checked={on}
                        onClick={() => onChange(d.key, c)}
                        className={`rounded-lg border px-3 py-2.5 text-start text-[14px] transition-colors ${on ? "border-brand bg-[color-mix(in_oklab,var(--brand)_8%,var(--surface))]" : "border-line hover:border-line-strong"}`}
                      >
                        <span className={on ? "font-medium text-ink" : "text-ink-2"}>{title}</span>
                        {desc && <span className="block text-[13px] text-muted">{desc}</span>}
                      </button>
                    );
                  })}
                </div>
              ) : (
                <select id={id} className="field" value={String(value)} onChange={(e) => onChange(d.key, e.target.value)}>
                  {d.choices.map((c) => (
                    <option key={c} value={c}>
                      {d.key === "summaryLang" && c !== "same" ? LOCALES.find((l) => l.code === c)?.name ?? c : d.key === "rotation" || d.key === "angle" ? `${c}°` : tOr(`choice.${d.key}.${c}`, c)}
                    </option>
                  ))}
                </select>
              )
            )}
            {d.type === "multi" && (
              <LangPicker id={id} choices={d.choices} max={d.max} value={String(value ?? d.default)} fallback={d.default} restore={restore} onChange={(v) => onChange(d.key, v)} />
            )}
            {d.type === "password" && d.strength && (
              <PasswordOption id={id} value={String(value ?? "")} onChange={(v, suggested) => {
                onChange(d.key, v);
                if (suggested && d.confirm) onChange(d.confirm, v);
              }} />
            )}
            {(d.type === "text" || (d.type === "password" && !d.strength)) && (
              <input
                id={id}
                type={d.type}
                className="field"
                value={String(value ?? "")}
                placeholder={d.type === "text" ? d.placeholder : undefined}
                autoComplete={d.type === "password" ? "new-password" : "off"}
                onChange={(e) => onChange(d.key, e.target.value)}
              />
            )}
            {d.type === "number" && (
              <input
                id={id}
                type="number"
                inputMode="numeric"
                className="field tabular"
                min={d.min}
                max={d.max}
                step={d.step ?? 1}
                value={Number(value)}
                onChange={(e) => onChange(d.key, Math.min(d.max, Math.max(d.min, Number(e.target.value) || d.min)))}
              />
            )}
            {d.type === "range" && (
              <input
                id={id}
                type="range"
                className="w-full accent-[var(--brand)]"
                min={d.min}
                max={d.max}
                step={d.step ?? 1}
                value={Number(value)}
                onChange={(e) => onChange(d.key, Number(e.target.value))}
              />
            )}
            {d.type === "color" && (
              <div className="flex items-center gap-2">
                {["#1f2937", "#d33f6a", "#2f6fed", "#12a37f", "#e2662b", "#7b4fe0"].map((c) => (
                  <button
                    key={c}
                    aria-label={c}
                    aria-pressed={value === c}
                    onClick={() => onChange(d.key, c)}
                    className="h-8 w-8 rounded-full ring-offset-2 ring-offset-[var(--surface)] aria-pressed:ring-2 aria-pressed:ring-[var(--ink)]"
                    style={{ background: c }}
                  />
                ))}
                <input id={id} type="color" value={String(value)} onChange={(e) => onChange(d.key, e.target.value)} className="h-8 w-10 cursor-pointer rounded-md border border-line bg-transparent" />
              </div>
            )}
            {d.type === "position" && (
              <div className={`grid w-[156px] gap-1.5 ${d.grid === 9 ? "grid-cols-3" : "grid-cols-3"}`} role="radiogroup" aria-label={label}>
                {(d.grid === 9
                  ? ["top-left", "top-center", "top-right", "middle-left", "middle-center", "middle-right", "bottom-left", "bottom-center", "bottom-right"]
                  : ["top-left", "top-center", "top-right", "bottom-left", "bottom-center", "bottom-right"]
                ).map((p, i) => (
                  <button
                    key={p}
                    role="radio"
                    aria-checked={value === p}
                    aria-label={t(`pos.${p}`)}
                    title={t(`pos.${p}`)}
                    onClick={() => onChange(d.key, p)}
                    className={`grid h-11 place-items-center rounded-lg border transition-colors ${value === p ? "border-brand bg-[color-mix(in_oklab,var(--brand)_12%,var(--surface))]" : "border-line hover:border-line-strong"} ${d.grid === 6 && i === 3 ? "mt-6" : ""} ${d.grid === 6 && i > 3 ? "mt-6" : ""}`}
                  >
                    <span className={`h-2 w-2 rounded-full ${value === p ? "bg-brand" : "bg-line-strong"}`} />
                  </button>
                ))}
              </div>
            )}
            {d.type === "image" && <ImageOption value={value as File | undefined} onChange={(f) => onChange(d.key, f)} />}
          </div>
        );
      })}
    </div>
  );
}

function ImageOption({ value, onChange }: { value?: File; onChange: (f: File | undefined) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const { t } = useI18n();
  return (
    <div className="flex items-center gap-2">
      <input ref={ref} type="file" accept="image/*" hidden onChange={(e) => e.target.files?.[0] && onChange(e.target.files[0])} />
      <button className="btn btn-quiet btn-sm min-w-0 flex-1" onClick={() => ref.current?.click()}>
        <ImagePlus size={16} />
        <span className="truncate">{value ? value.name : t("opt.markImage")}</span>
      </button>
      {value && (
        <button className="icon-btn" aria-label={t("ws.remove")} onClick={() => onChange(undefined)}>
          <X size={16} />
        </button>
      )}
    </div>
  );
}

// A new password: shown or hidden, rated as it's typed, or suggested (and
// then shown, so it can be copied).
function PasswordOption({ id, value, onChange }: { id: string; value: string; onChange: (v: string, suggested: boolean) => void }) {
  const { t } = useI18n();
  const [shown, setShown] = useState(false);
  const [suggested, setSuggested] = useState<string | null>(null);
  const level = passwordStrength(value);
  return (
    <div>
      <div className="relative">
        <input
          id={id}
          type={shown ? "text" : "password"}
          className="field pe-11"
          value={value}
          autoComplete="new-password"
          spellCheck={false}
          aria-describedby={`${id}-strength`}
          onChange={(e) => {
            setSuggested(null);
            onChange(e.target.value, false);
          }}
        />
        <button
          type="button"
          className="icon-btn absolute end-1 top-1/2 -translate-y-1/2"
          aria-label={shown ? t("pw.hide") : t("pw.show")}
          aria-pressed={shown}
          onClick={() => setShown((s) => !s)}
        >
          {shown ? <EyeOff size={16} /> : <Eye size={16} />}
        </button>
      </div>
      <div id={`${id}-strength`} className="mt-2 flex h-4 items-center gap-2" aria-live="polite">
        <span className="flex w-24 shrink-0 gap-1" aria-hidden="true">
          {[1, 2, 3, 4].map((n) => (
            <span key={n} className={`h-1 flex-1 rounded-full ${n <= level ? (level <= 1 ? "bg-danger" : level === 2 ? "bg-accent" : "bg-success") : "bg-line-strong"}`} />
          ))}
        </span>
        {value && <span className="text-[12px] text-muted">{t("pw.strength", { level: t(`pw.level.${level}`) })}</span>}
      </div>
      <button
        type="button"
        className="btn btn-quiet btn-sm mt-2"
        onClick={() => {
          const pw = suggestPassword();
          setSuggested(pw);
          setShown(true);
          onChange(pw, true);
        }}
      >
        <Sparkles size={14} /> {t("pw.suggest")}
      </button>
      {suggested && suggested === value && <p className="mt-2 text-[13px] text-muted">{t("pw.suggested")}</p>}
    </div>
  );
}
