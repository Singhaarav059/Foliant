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

// Where a tool's AI runs, and the on-device models it can use. A device
// that can run the models (src/lib/ai/engine.ts deviceCanRunModels) uses
// on-device AI only, and the panel says what downloading a model gives.
// Other devices, where this copy of the site has it, get server AI
// (src/lib/ai/cloud.ts) by default: the panel says what it sends, with the
// providers named in the privacy policy, and "On this device" says what it
// gives up. Phones and tablets are never offered model downloads. The model list shows what each model does, its download size
// and whether it's on this device. Nothing downloads until the visitor
// presses Download; after that it works offline. `value` is what's in use
// ("cloud" for server AI, a model, or "" for no model), which the tool's run
// reads as the aiModel option. `task` picks the wording ("chat",
// "summarize", "translate").
export function AiModels({ models, value, onChange, task }: { models: string[]; value: string; onChange: (id: string) => void; task: string }) {
  const { t, href } = useI18n();
  const [ids, setIds] = useState<ModelId[]>([]);
  const [sizes, setSizes] = useState<Record<string, number>>({});
  const [status, setStatus] = useState<Status | null>(null);
  const [cloud, setCloud] = useState(false);
  // Known once the device has been checked; until then the panel waits.
  const [capable, setCapable] = useState<boolean | null>(null);
  // A model just failed to run here: server AI is offered instead.
  const [fellBack, setFellBack] = useState(false);
  // Phones get no model downloads.
  const [phone, setPhone] = useState(false);
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
      const able = !!s && e.deviceCanRunModels(s);
      const onPhone = e.isPhone();
      setPhone(onPhone);
      setCloud(hasCloud);
      setCapable(able);
      if (s) setStatus(s);
      // A capable device never uses server AI, whatever was picked before.
      if (picked.current || (value && !(able && value === c.CLOUD))) return;
      // The visitor's last choice; else server AI where it's offered; else the most capable model on the device.
      const chosen = e.chosenModel();
      const best = s ? [...served].reverse().find((m) => s.stored[m]) : undefined;
      if (!able && hasCloud && (chosen === c.CLOUD || !chosen)) onChange(c.CLOUD);
      else if (!onPhone && chosen && chosen !== c.CLOUD && chosen !== "device" && served.includes(chosen) && s?.stored[chosen]) onChange(chosen);
      else {
        setDevice(true);
        onChange(onPhone ? "" : (best ?? ""));
      }
    });
    const failed = () => {
      setCapable(false);
      setFellBack(true);
      import("@/lib/ai/cloud").then(async (c) => {
        if (!(await c.cloudAvailable())) return;
        setDevice(false);
        onChange(c.CLOUD);
      });
    };
    window.addEventListener("nopload:ai-device-failed", failed);
    return () => {
      live = false;
      window.removeEventListener("nopload:ai-device-failed", failed);
    };
    // Once per tool: `value` and `onChange` change with every option.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [models]);

  // A phone with no server AI here has nothing to choose.
  if (capable === null || (!ids.length && !cloud) || (phone && !cloud)) return null;
  // Server AI is offered only to devices that can't run the models.
  const server = cloud && !capable;

  const choose = async (id: Choice) => {
    picked.current = true;
    (await import("@/lib/ai/engine")).chooseModel(id);
    setDevice(id !== "cloud");
    onChange(id === "device" ? "" : id);
  };

  // On this device: the most capable model downloaded, else none yet (always none on a phone).
  const toDevice = () => {
    const best = status && !phone ? [...ids].reverse().find((m) => status.stored[m]) : undefined;
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

  const onCloud = server && value === "cloud";
  const onDevice = !onCloud && (device || !server || !!value);
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

  // On-device AI only: a device that can run the models (it's told what a
  // download gives, and why there's no server AI), or no server AI here.
  if (!server)
    return (
      <section aria-labelledby="ai-models" className="mt-6 border-t border-line pt-5" data-ai-models data-ai-mode="device" data-ai-capable={capable ? "" : undefined}>
        <p id="ai-models" className="text-[14px] font-medium">{t("ai.models")}</p>
        {capable && cloud ? (
          <div className="mt-1 space-y-1.5 text-[13px] leading-relaxed text-ink-2">
            <p>{t(`ai.capable.${task}`)}</p>
            <p className="text-muted">{t("ai.capable.why")}</p>
          </div>
        ) : (
          <p className="mt-1 text-[13px] text-muted">{t("ai.modelsNote")}</p>
        )}
        {list}
      </section>
    );

  const card = (on: boolean) => `block w-full rounded-lg border px-3 py-2.5 text-start ${on ? "border-brand bg-[color-mix(in_oklab,var(--brand)_8%,var(--surface))]" : "border-line hover:border-line-strong"}`;
  return (
    <section aria-labelledby="ai-where" className="mt-6 border-t border-line pt-5" data-ai-models data-ai-mode={onCloud ? "cloud" : "device"}>
      <p id="ai-where" className="text-[14px] font-medium">{t("ai.where")}</p>
      {fellBack && <p className="mt-1 text-[13px] text-ink-2" data-ai-fell-back>{t("ai.deviceFailed")}</p>}
      <div role="radiogroup" aria-labelledby="ai-where" className="mt-3 space-y-2">
        <button role="radio" aria-checked={onCloud} onClick={() => void choose("cloud")} className={card(onCloud)} data-ai-choice="cloud">
          <span className="flex items-center gap-1.5 text-[14px] font-medium"><Cloud size={15} /> {t("ai.server")} {onCloud && <Check size={15} className="ms-auto" />}</span>
          <span className="mt-0.5 block text-[13px] text-muted">{t("ai.server.desc")}</span>
        </button>
        {onCloud && (
          <div className="rounded-lg bg-[color-mix(in_oklab,var(--ink)_4%,var(--surface))] px-3 py-2.5 text-[13px] leading-relaxed text-ink-2" data-ai-disclosure>
            <p>{t(`ai.server.sends.${task}`)}</p>
            <p className="mt-1.5">{t("ai.server.who")}</p>
            <a className="mt-1.5 inline-block underline underline-offset-2 hover:text-ink" href={`${href("/privacy")}#ai`}>{t("ai.server.more")}</a>
          </div>
        )}
        <button role="radio" aria-checked={onDevice} onClick={toDevice} className={card(onDevice)} data-ai-choice="device">
          <span className="flex items-center gap-1.5 text-[14px] font-medium"><Laptop size={15} /> {t("ai.device")} {onDevice && <Check size={15} className="ms-auto" />}</span>
          <span className="mt-0.5 block text-[13px] text-muted">{t("ai.device.desc")}</span>
        </button>
      </div>
      {onDevice && (
        <div className="mt-3" data-ai-device>
          {phone ? (
            <p className="text-[13px] leading-relaxed text-ink-2" data-ai-phone>{t(task === "translate" ? "ai.device.limitsPhoneTranslate" : "ai.device.limitsPhone")}</p>
          ) : (
            <>
              <p className="text-[13px] leading-relaxed text-ink-2">{t("ai.device.limits")}{task === "translate" && <> {t("ai.device.limitsTranslate")}</>}</p>
              {list}
            </>
          )}
        </div>
      )}
    </section>
  );
}
