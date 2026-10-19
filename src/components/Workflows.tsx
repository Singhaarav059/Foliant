"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowDown, Download, Loader2, Play, Plus, Save, Trash2, Upload, X } from "lucide-react";
import { useI18n } from "./I18n";
import { useUser, postJson } from "./User";
import { ToolIcon } from "./ToolIcon";
import { Options } from "./workspace/Options";
import { Dropzone, useFileIntake } from "./workspace/Dropzone";
import { Results } from "./workspace/Results";
import { ErrorBox, useProblem, type Problem } from "./workspace/ErrorBox";
import { defaultOptions, TOOLS, toolById, type ToolId } from "@/lib/tools";
import type { Output } from "@/lib/pdf/common";
import { markUnrestricted, PERMISSIONS, protectProblem, withoutSecrets } from "@/lib/pdf/password";
import { BRAND } from "@/lib/brand";
import { STATIC } from "@/lib/mode";

type Step = { tool: ToolId; options: Record<string, unknown> };
type Saved = { id: number | string; name: string; steps: Step[] };

const CHAINABLE = TOOLS.filter((t) => t.chainable);
const LOCAL_KEY = "workflows";

function readLocal(): Saved[] {
  try {
    return JSON.parse(localStorage.getItem(LOCAL_KEY) ?? "[]");
  } catch {
    return [];
  }
}
function writeLocal(list: Saved[]) {
  try {
    localStorage.setItem(LOCAL_KEY, JSON.stringify(list));
  } catch {
    /* storage blocked: workflow still runs this session */
  }
}
// Imported files are untrusted: keep only steps that name a chainable tool.
const isWorkflow = (w: unknown): w is { name: string; steps: Step[] } => {
  const x = w as { name?: unknown; steps?: unknown };
  return typeof x?.name === "string" && Array.isArray(x.steps) && x.steps.length > 0 &&
    x.steps.every((s: { tool?: unknown; options?: unknown }) =>
      CHAINABLE.some((c) => c.id === s?.tool) && typeof s.options === "object" && s.options !== null && !Array.isArray(s.options));
};
const stripSecrets = (steps: Step[]) =>
  steps.map((s) => ({ tool: s.tool, options: withoutSecrets(Object.fromEntries(Object.entries(s.options).filter(([, v]) => !(v instanceof File)))) }));

export function Workflows() {
  const { t, tOr } = useI18n();
  const problem = useProblem();
  const { user, ready } = useUser();
  const [saved, setSaved] = useState<Saved[]>([]);
  const [name, setName] = useState("");
  const [steps, setSteps] = useState<Step[]>([]);
  const [files, setFiles] = useState<File[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<Problem | null>(null);
  const say = (text: string) => setError({ text });
  const [outputs, setOutputs] = useState<Output[] | null>(null);
  // The running workflow's controller: Cancel or leaving the page stops its engines.
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);
  const addFiles = (f: File[]) => setFiles((list) => [...list, ...f.filter((x) => /\.pdf$/i.test(x.name))]);
  // Dropped or pasted anywhere on the page.
  const over = useFileIntake(addFiles);

  const load = useCallback(async () => {
    if (user) {
      const d = await fetch("/api/workflows").then((r) => r.json()).catch(() => ({ workflows: [] }));
      setSaved(d.workflows ?? []);
    } else setSaved(readLocal());
  }, [user]);

  useEffect(() => {
    if (!ready) return;
    let live = true;
    const pending = user
      ? fetch("/api/workflows").then((r) => r.json()).then((d) => (d.workflows ?? []) as Saved[]).catch(() => [] as Saved[])
      : Promise.resolve(readLocal());
    pending.then((list) => live && setSaved(list));
    return () => {
      live = false;
    };
  }, [ready, user]);

  const addStep = (id: ToolId) => setSteps((s) => [...s, { tool: id, options: defaultOptions(toolById(id)) }]);

  const save = async () => {
    if (!steps.length) return say(t("wf.needSteps"));
    const wfName = name.trim() || steps.map((s) => t(`tool.${s.tool}.name`)).join(" → ");
    if (user) await postJson("/api/workflows", { name: wfName, steps: stripSecrets(steps) });
    else writeLocal([{ id: crypto.randomUUID(), name: wfName, steps: stripSecrets(steps) }, ...readLocal()]);
    setName("");
    await load();
  };

  const remove = async (id: Saved["id"]) => {
    if (user) await postJson(`/api/workflows/${id}`, undefined, "DELETE");
    else writeLocal(readLocal().filter((w) => w.id !== id));
    await load();
  };

  const exportAll = () => {
    const data = { app: BRAND.name, version: 1, workflows: saved.map(({ name, steps }) => ({ name, steps })) };
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `${BRAND.name.toLowerCase()}-workflows.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };

  const importFile = async (file: File) => {
    setError(null);
    let list: { name: string; steps: Step[] }[] = [];
    try {
      const data = JSON.parse(await file.text());
      list = (Array.isArray(data?.workflows) ? data.workflows : []).filter(isWorkflow)
        .map((w: { name: string; steps: Step[] }) => ({ name: w.name.slice(0, 80), steps: stripSecrets(w.steps) }));
    } catch {
      /* not JSON */
    }
    if (!list.length) return say(t("wf.importBad"));
    try {
      if (user) for (const w of list) await postJson("/api/workflows", w);
      else writeLocal([...list.map((w) => ({ id: crypto.randomUUID(), ...w })), ...readLocal()]);
    } catch (e) {
      setError(problem(e));
    }
    await load();
  };

  const runAll = async () => {
    setError(null);
    if (!steps.length) return say(t("wf.needSteps"));
    if (!files.length) return say(t("ws.needMore", { n: 1 }));
    const protect = steps.find((s) => s.tool === "protect");
    const o = protect?.options ?? {};
    const bad = protect && protectProblem({
      ...Object.fromEntries(PERMISSIONS.map((k) => [k, o[k] !== false])),
      openPassword: o.openPassword !== false, password: String(o.password ?? ""), confirmPassword: String(o.confirmPassword ?? ""), ownerPassword: String(o.ownerPassword ?? ""),
    });
    if (bad?.code === "passwordEmpty") return say(t("ws.passwordEmpty"));
    if (bad?.code === "noRestriction") return say(t("ws.noRestriction"));
    if (bad?.code === "passwordMismatch") return say(t("ws.passwordMismatch"));
    if (bad?.code === "ownerSameAsOpen") return say(t("ws.ownerSameAsOpen"));
    if (bad?.code === "passwordTooLong") return say(t("ws.passwordTooLong", { max: bad.max }));
    const { runTool } = await import("@/lib/pdf/run");
    let current = files;
    let out: Output[] = [];
    const controller = (abort.current = new AbortController());
    try {
      for (let i = 0; i < steps.length; i++) {
        const s = steps[i];
        setStatus(t("wf.running", { n: i + 1, total: steps.length, tool: t(`tool.${s.tool}.name`) }));
        out = await runTool(s.tool, current, s.options, undefined, { page: tOr("ws.page", "Page {n}"), pageOf: tOr("ws.processingPage", "Page {n} of {total}"), nOf: tOr("fmt.nOfTotal", "{n} of {total}") }, controller.signal);
        current = out.map((o) => new File([o.blob], o.name, { type: "application/pdf" }));
      }
      setOutputs(steps.some((s) => s.tool === "protect" || s.tool === "unlock") ? out : await markUnrestricted(files, out));
    } catch (e) {
      if (!controller.signal.aborted) setError(problem(e));
    } finally {
      if (abort.current === controller) abort.current = null;
      setStatus(null);
    }
  };

  if (outputs) {
    return (
      <div className="px-4 pt-12">
        <Results tool={toolById(steps[steps.length - 1].tool)} outputs={outputs} onReset={() => { setOutputs(null); setFiles([]); }} />
      </div>
    );
  }

  const pdfTool = toolById("merge");

  return (
    <div className="mx-auto max-w-[1100px] px-4 pb-10 pt-12 sm:px-6">
      <h1 className="text-[2.25rem] font-semibold tracking-[-0.04em]">{t("wf.title")}</h1>
      <p className="mt-2 max-w-[620px] text-[16px] text-muted">{t("wf.subtitle")}</p>

      <div className="mt-8 grid gap-6 lg:grid-cols-[1fr_340px]">
        <section className="card min-w-0 p-5 sm:p-6">
          <h2 className="mb-4 text-[16px] font-medium tracking-[-0.01em]">{t("wf.new")}</h2>
          <input className="field mb-5" placeholder={t("wf.name")} aria-label={t("wf.name")} value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />

          <ol className="space-y-2">
            {steps.map((s, i) => {
              const tool = toolById(s.tool);
              return (
                <li key={i}>
                  {i > 0 && <ArrowDown size={16} className="mx-auto my-1 text-muted" aria-hidden />}
                  <details className="rounded-xl border border-line bg-bg" open={tool.options.length > 0 && i === steps.length - 1}>
                    <summary className="flex cursor-pointer list-none items-center gap-3 p-3">
                      <span className="tabular text-[13px] text-muted">{i + 1}</span>
                      <ToolIcon tool={tool} size={32} />
                      <span className="flex-1 font-medium">{t(`tool.${tool.id}.name`)}</span>
                      <button className="icon-btn" aria-label={t("ws.remove")} onClick={(e) => { e.preventDefault(); setSteps((list) => list.filter((_, k) => k !== i)); }}>
                        <X size={16} />
                      </button>
                    </summary>
                    {tool.options.length > 0 && (
                      <div className="border-t border-line p-4">
                        <Options defs={tool.options} values={s.options}
                          onChange={(k, v) => setSteps((list) => list.map((x, j) => (j === i ? { ...x, options: { ...x.options, [k]: v } } : x)))} />
                      </div>
                    )}
                  </details>
                </li>
              );
            })}
          </ol>

          <div className="mt-4">
            <p className="eyebrow mb-2.5">{t("wf.addStep")}</p>
            <div className="flex flex-wrap gap-2">
              {CHAINABLE.map((tool) => (
                <button key={tool.id} className="group flex items-center gap-2 rounded-lg border border-line bg-surface py-1 ps-1 pe-3 text-[14px] transition-colors hover:border-line-strong"
                  disabled={tool.id === "merge" && steps.length > 0} onClick={() => addStep(tool.id)}>
                  <ToolIcon tool={tool} size={24} /> {t(`tool.${tool.id}.name`)} <Plus size={14} className="text-muted" />
                </button>
              ))}
            </div>
          </div>

          <div className="mt-8 border-t border-line pt-6">
            {files.length === 0 ? (
              <Dropzone tool={{ ...pdfTool, multiple: true }} onFiles={addFiles} over={over} />
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                {files.map((f) => <span key={f.name + f.size} className="rounded-md bg-surface-2 px-2.5 py-1 text-[13px]">{f.name}</span>)}
                <button className="icon-btn" aria-label={t("ws.remove")} onClick={() => setFiles([])}><X size={16} /></button>
              </div>
            )}
          </div>

          {error && <ErrorBox problem={error} className="mt-4" />}
          <div className="mt-6 flex flex-wrap gap-2">
            <button className="btn btn-primary" disabled={!!status} onClick={runAll}>
              {status ? <Loader2 size={17} className="animate-spin" /> : <Play size={17} />} {t("wf.run")}
            </button>
            <button className="btn btn-quiet" onClick={save}><Save size={17} /> {t("wf.save")}</button>
          </div>
          {status && (
            <div className="mt-3 flex items-center gap-3">
              <p className="text-[14px] text-muted" aria-live="polite">{status}</p>
              <button className="btn btn-quiet btn-sm" onClick={() => abort.current?.abort()}>{t("ws.cancel")}</button>
            </div>
          )}
        </section>

        <aside className="card h-max min-w-0 p-5">
          <h2 className="mb-3 text-[16px] font-medium tracking-[-0.01em]">{t("wf.title")}</h2>
          {!user && <p className="mb-3 text-[13px] text-muted">{STATIC ? t("wf.savedHere") : t("wf.savedLocally")}</p>}
          {saved.length === 0 ? <p className="text-[15px] text-muted">{t("wf.empty")}</p> : (
            <ul className="space-y-2">
              {saved.map((w) => (
                <li key={w.id} className="flex items-center gap-2 rounded-xl border border-line p-2.5">
                  <button className="min-w-0 flex-1 text-start" onClick={() => { setSteps(w.steps.map((s) => ({ tool: s.tool, options: { ...defaultOptions(toolById(s.tool)), ...s.options } }))); setName(w.name); }}>
                    <p className="truncate text-[15px] font-medium">{w.name}</p>
                    <p className="truncate text-[13px] text-muted">{w.steps.map((s) => t(`tool.${s.tool}.name`)).join(" → ")}</p>
                  </button>
                  <button className="icon-btn hover:text-danger" aria-label={t("wf.delete")} onClick={() => remove(w.id)}><Trash2 size={16} /></button>
                </li>
              ))}
            </ul>
          )}
          <div className="mt-4 flex flex-wrap gap-2 border-t border-line pt-4">
            <button className="btn btn-quiet btn-sm grow" disabled={!saved.length} onClick={exportAll}>
              <Download size={15} /> {t("wf.export")}
            </button>
            <label className="btn btn-quiet btn-sm grow cursor-pointer">
              <Upload size={15} /> {t("wf.import")}
              <input type="file" accept=".json,application/json" className="sr-only"
                onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void importFile(f); }} />
            </label>
          </div>
        </aside>
      </div>
    </div>
  );
}
