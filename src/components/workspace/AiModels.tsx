"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Cloud, Download, Laptop, Loader2, Trash2, X } from "lucide-react";
import { useI18n } from "../I18n";
import { humanSize } from "@/lib/pdf/common";
import type { Choice, ModelId, Status } from "@/lib/ai/engine";

// Loads the AI code and starts its worker, so both work offline after one
// visit (src/lib/offline.ts), and the runtime too once a model is on the
// device. No model is downloaded.
export const prepareAi = () =>
  import("@/lib/ai/engine").then(async (e) => {
    const s = await e.status();
    if (Object.values(s.stored).some(Boolean)) await e.prepareRuntime();
  });

// Where a tool's AI runs, and the on-device models it can use. Where this
// copy of the site has the cloud AI (src/lib/ai/cloud.ts), it is the
// default, and the panel says what it sends and to whom; "On this device"
// says what that gives up, then lists the models: what each does, its
// download size, whether it's on this device. Nothing downloads until the
// visitor presses Download; after that it works offline. `value` is what's
// in use ("cloud", a model, or "" for no model), which the tool's run reads
// as the aiModel option. `task` picks the wording ("chat", "summarize",
// "translate").
export function AiModels({ models, value, onChange, task }: { models: string[]; value: string; onChange: (id: string) => void; task: string }) {
  const { t, href } = useI18n();
  const [ids, setIds] = useState<ModelId[]>([]);
  const [sizes, setSizes] = useState<Record<string, number>>({});
  const [status, setStatus] = useState<Status | null>(null);
  const [cloud, setCloud] = useState(false);
  // On this device, though no model is in use (or none is downloaded).
  const [device, setDevice] = useState(false);
  const [busy, setBusy] = useState<{ id: ModelId; done: number; total: number } | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const picked = useRef(false);

  useEffect(() => {
    let live = true;
    Promise.all([import("@/lib/ai/engine"), import("@/lib/ai/cloud")]).then(async ([e, c]) => {
      const served = e.servedModels().filter((m) => models.includes(m));
      const [s, hasCloud] = await Promise.all([e.status().catch(() => null), c.cloudAvailable()]);
      if (!live) return;
      setIds(served);
      setSizes(Object.fromEntries(served.map((m) => [m, e.sizeOf(m)])));
      setCloud(hasCloud);
      if (s) setStatus(s);
      if (picked.current || value) return;
      // The visitor's last choice; else the cloud AI where there is one; else the most capable model on the device.
      const chosen = e.chosenModel();
      const best = s ? [...served].reverse().find((m) => s.stored[m]) : undefined;
      if (hasCloud && (chosen === c.CLOUD || !chosen)) onChange(c.CLOUD);
      else if (chosen && chosen !== c.CLOUD && chosen !== "device" && served.includes(chosen) && s?.stored[chosen]) onChange(chosen);
      else {
        setDevice(true);
        if (best) onChange(best);
      }
    });
    return () => {
      live = false;
    };
    // Once per tool: `value` and `onChange` change with every option.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [models]);

  if (!ids.length && !cloud) return null;

  const choose = async (id: Choice) => {
    picked.current = true;
    (await import("@/lib/ai/engine")).chooseModel(id);
    setDevice(id !== "cloud");
    onChange(id === "device" ? "" : id);
  };

  // On this device: the most capable model downloaded, else none yet.
  const toDevice = () => {
    const best = status ? [...ids].reverse().find((m) => status.stored[m]) : undefined;
    void choose(best ?? "device");
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
    if (value === id) void choose("device");
  };

  const onCloud = cloud && value === "cloud";
  const onDevice = !onCloud && (device || !cloud || !!value);
  const gen = ids.some((m) => m !== "light");
  const list = (
    <>
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
                  <button role="radio" aria-checked={on} onClick={() => void choose(on ? "device" : id)} className="min-w-0 flex-1 text-start">
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
    </>
  );

  // No cloud AI here: the on-device panel as it always was.
  if (!cloud)
    return (
      <section aria-labelledby="ai-models" className="mt-6 border-t border-line pt-5" data-ai-models>
        <p id="ai-models" className="text-[14px] font-medium">{t("ai.models")}</p>
        <p className="mt-1 text-[13px] text-muted">{t("ai.modelsNote")}</p>
        {list}
      </section>
    );

  const card = (on: boolean) => `block w-full rounded-lg border px-3 py-2.5 text-start ${on ? "border-brand bg-[color-mix(in_oklab,var(--brand)_8%,var(--surface))]" : "border-line hover:border-line-strong"}`;
  return (
    <section aria-labelledby="ai-where" className="mt-6 border-t border-line pt-5" data-ai-models data-ai-mode={onCloud ? "cloud" : "device"}>
      <p id="ai-where" className="text-[14px] font-medium">{t("ai.where")}</p>
      <div role="radiogroup" aria-labelledby="ai-where" className="mt-3 space-y-2">
        <button role="radio" aria-checked={onCloud} onClick={() => void choose("cloud")} className={card(onCloud)} data-ai-choice="cloud">
          <span className="flex items-center gap-1.5 text-[14px] font-medium"><Cloud size={15} /> {t("ai.cloud")} {onCloud && <Check size={15} className="ms-auto" />}</span>
          <span className="mt-0.5 block text-[13px] text-muted">{t("ai.cloud.desc")}</span>
        </button>
        {onCloud && (
          <div className="rounded-lg bg-[color-mix(in_oklab,var(--ink)_4%,var(--surface))] px-3 py-2.5 text-[13px] leading-relaxed text-ink-2" data-ai-disclosure>
            <p>{t(`ai.cloud.sends.${task}`)}</p>
            <p className="mt-1.5">{t("ai.cloud.who")}</p>
            <a className="mt-1.5 inline-block underline underline-offset-2 hover:text-ink" href={`${href("/privacy")}#ai`}>{t("ai.cloud.more")}</a>
          </div>
        )}
        <button role="radio" aria-checked={onDevice} onClick={toDevice} className={card(onDevice)} data-ai-choice="device">
          <span className="flex items-center gap-1.5 text-[14px] font-medium"><Laptop size={15} /> {t("ai.device")} {onDevice && <Check size={15} className="ms-auto" />}</span>
          <span className="mt-0.5 block text-[13px] text-muted">{t("ai.device.desc")}</span>
        </button>
      </div>
      {onDevice && (
        <div className="mt-3" data-ai-device>
          <p className="text-[13px] leading-relaxed text-ink-2">{t("ai.device.limits")}{task === "translate" && <> {t("ai.device.limitsTranslate")}</>}</p>
          {list}
        </div>
      )}
    </section>
  );
}
