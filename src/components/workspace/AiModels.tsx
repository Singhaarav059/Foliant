"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Download, Loader2, Trash2, X } from "lucide-react";
import { useI18n } from "../I18n";
import { humanSize } from "@/lib/pdf/common";
import type { ModelId, Status } from "@/lib/ai/engine";

// Loads the AI code and starts its worker, so both work offline after one
// visit (src/lib/offline.ts), and the runtime too once a model is on the
// device. No model is downloaded.
export const prepareAi = () =>
  import("@/lib/ai/engine").then(async (e) => {
    const s = await e.status();
    if (Object.values(s.stored).some(Boolean)) await e.prepareRuntime();
  });

// The on-device AI models a tool can use: what each does, its download size,
// whether it's on this device. Nothing downloads until the visitor presses
// Download; after that it works offline. `value` is the model in use ("" for
// none), which the tool's run reads as the aiModel option.
export function AiModels({ models, value, onChange }: { models: string[]; value: string; onChange: (id: string) => void }) {
  const { t } = useI18n();
  const [ids, setIds] = useState<ModelId[]>([]);
  const [sizes, setSizes] = useState<Record<string, number>>({});
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState<{ id: ModelId; done: number; total: number } | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const picked = useRef(false);

  useEffect(() => {
    let live = true;
    import("@/lib/ai/engine").then(async (e) => {
      const served = e.servedModels().filter((m) => models.includes(m));
      if (!live) return;
      setIds(served);
      setSizes(Object.fromEntries(served.map((m) => [m, e.sizeOf(m)])));
      const s = await e.status().catch(() => null);
      if (!live || !s) return;
      setStatus(s);
      // Use what's on the device: the visitor's last choice, else the most capable.
      if (!picked.current && !value) {
        const chosen = e.chosenModel();
        const pick = chosen && served.includes(chosen) && s.stored[chosen] ? chosen : [...served].reverse().find((m) => s.stored[m]);
        if (pick) onChange(pick);
      }
    });
    return () => {
      live = false;
    };
    // Once per tool: `value` and `onChange` change with every option.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [models]);

  if (!ids.length) return null;

  const choose = async (id: ModelId) => {
    picked.current = true;
    (await import("@/lib/ai/engine")).chooseModel(id);
    onChange(id);
  };

  const get = async (id: ModelId) => {
    setFailed(null);
    const e = await import("@/lib/ai/engine");
    const ctl = new AbortController();
    abort.current = ctl;
    setBusy({ id, done: 0, total: sizes[id] });
    try {
      await e.download(id, (done, total) => setBusy({ id, done, total }), ctl.signal);
      await e.prepareRuntime().catch(() => {});
      setStatus(await e.status());
      await choose(id);
    } catch (err) {
      if (!(err instanceof e.Aborted)) setFailed(id);
    } finally {
      setBusy(null);
      abort.current = null;
    }
  };

  const drop = async (id: ModelId) => {
    const e = await import("@/lib/ai/engine");
    await e.removeModel(id);
    setStatus(await e.status());
    if (value === id) onChange("");
  };

  const gen = ids.some((m) => m !== "light");
  return (
    <section aria-labelledby="ai-models" className="mt-6 border-t border-line pt-5" data-ai-models>
      <p id="ai-models" className="text-[14px] font-medium">{t("ai.models")}</p>
      <p className="mt-1 text-[13px] text-muted">{t("ai.modelsNote")}</p>
      {gen && status && !status.f16 && <p className="mt-2 text-[13px] text-muted">{t("ai.noWebgpu")}</p>}
      <ul className="mt-3 space-y-2">
        {ids.map((id) => {
          const stored = status?.stored[id];
          const on = value === id;
          const loading = busy?.id === id;
          return (
            <li key={id} className={`rounded-lg border px-3 py-2.5 ${on ? "border-brand bg-[color-mix(in_oklab,var(--brand)_8%,var(--surface))]" : "border-line"}`}>
              <div className="flex items-start gap-2">
                {stored ? (
                  <button role="radio" aria-checked={on} onClick={() => (on ? onChange("") : void choose(id))} className="min-w-0 flex-1 text-start">
                    <span className="flex items-center gap-1.5 text-[14px] font-medium">{on && <Check size={15} />} {t(`ai.model.${id}`)}</span>
                    <span className="block text-[13px] text-muted">{t(`ai.model.${id}.desc`)}</span>
                  </button>
                ) : (
                  <div className="min-w-0 flex-1">
                    <span className="block text-[14px] font-medium">{t(`ai.model.${id}`)}</span>
                    <span className="block text-[13px] text-muted">{t(`ai.model.${id}.desc`)}</span>
                  </div>
                )}
                {stored ? (
                  <button className="btn btn-quiet btn-sm" aria-label={t("ai.remove", { name: t(`ai.model.${id}`) })} onClick={() => void drop(id)}><Trash2 size={15} /></button>
                ) : loading ? (
                  <button className="btn btn-quiet btn-sm" aria-label={t("ws.cancel")} onClick={() => abort.current?.abort()}><X size={15} /></button>
                ) : (
                  <button className="btn btn-quiet btn-sm" disabled={!!busy || !status} onClick={() => void get(id)}>
                    <Download size={15} /> {humanSize(sizes[id])}
                  </button>
                )}
              </div>
              {loading && (
                <div className="mt-2" aria-live="polite">
                  <div className="h-1 overflow-hidden rounded-full bg-line">
                    <div className="h-full rounded-full bg-ink transition-[width] duration-300" style={{ width: `${Math.max(2, (busy.done / busy.total) * 100)}%` }} />
                  </div>
                  <p className="tabular mt-1 flex items-center gap-1.5 text-[12px] text-muted"><Loader2 size={12} className="animate-spin" /> {humanSize(busy.done)} / {humanSize(busy.total)}</p>
                </div>
              )}
              {failed === id && <p className="mt-1 text-[13px] text-danger">{t("ai.downloadFailed")}</p>}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
