"use client";

import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import { AlertTriangle, ArrowRight, Download, Loader2 } from "lucide-react";
import { useI18n } from "../I18n";
import { useUser, postJson } from "../User";
import { Dropzone, useFileIntake } from "./Dropzone";
import { FileBoard, type Item } from "./FileBoard";
import { Options } from "./Options";
import { PageBoard, type PageItem } from "./PageBoard";
import { Editor, prepareEditor } from "./Editor";
import { Scanner } from "./Scanner";
import { CompareView, prepareCompare } from "./CompareView";
import { ChatView, prepareChat } from "./ChatView";
import { AiModels, prepareAi } from "./AiModels";
import { ErrorBox, useProblem, type Problem } from "./ErrorBox";
import { Results } from "./Results";
import { PrintResults } from "./PrintResults";
import { PasteHtml } from "./PasteHtml";
import { clearHandoff, peekHandoff } from "@/lib/handoff";
import { fileExt, type Output, type Progress } from "@/lib/pdf/common";
import { fileError } from "@/lib/pdf/errors";
import { passwordTooLong } from "@/lib/pdf/password";
import { pageCount } from "@/lib/pdf/thumbs";
import { defaultOptions, LIGHT_OFFICE, LIMITS, toolById, type ToolId } from "@/lib/tools";

type Stage = "select" | "work" | "busy" | "done";
type Caps = { chrome: boolean; libreoffice: boolean };
type Job = { files: File[]; options: Record<string, unknown>; reloaded: boolean; agreed?: boolean };

const uid = () => crypto.randomUUID();

export function Workspace({ toolId }: { toolId: ToolId }) {
  const tool = toolById(toolId);
  const { t, tOr } = useI18n();
  const problem = useProblem();
  const { user } = useUser();
  // Files handed over from the previous tool's result start the workspace pre-filled.
  const [items, setItems] = useState<Item[]>(() => (peekHandoff() ?? []).map((file) => ({ id: uid(), file })));
  const [options, setOptions] = useState<Record<string, unknown>>(() => defaultOptions(tool));
  const [stage, setStage] = useState<Stage>(() => (peekHandoff()?.length ? "work" : "select"));
  const [progress, setProgress] = useState<{ value: number; label?: string }>({ value: 0 });
  const [outputs, setOutputs] = useState<Output[]>([]);
  const [error, setError] = useState<Problem | null>(null);
  const [pages, setPages] = useState<PageItem[]>([]);
  // The pages as the files list them, for the board's Reset.
  const [original, setOriginal] = useState<PageItem[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [url, setUrl] = useState("");
  const [caps, setCaps] = useState<Caps | null>(null);
  // An Office job waiting for the user to agree to LibreOffice's download,
  // and one brought back over a reload.
  const [ask, setAsk] = useState<Job | null>(null);
  const [resumed, setResumed] = useState<Job | null>(null);
  const run = useRef(0);
  const files = useMemo(() => items.map((i) => i.file), [items]);
  // Rotate turns every page by the chosen angle, on top of each page's own turn.
  const turn = tool.id === "rotate" ? Number(options.angle) || 0 : 0;
  // Office → PDF in the static build, which has a fidelity choice.
  const office = tool.options.some((o) => o.key === "fidelity");

  useEffect(() => {
    if (tool.runtime === "browser") return;
    fetch("/api/capabilities").then((r) => r.json()).then(setCaps).catch(() => setCaps(null));
  }, [tool.runtime]);

  const addFiles = useCallback(async (incoming: File[], base?: Item[]) => {
    setError(null);
    const ok: File[] = [];
    for (const f of incoming) {
      const ext = fileExt(f.name);
      const image = tool.accept.includes("jpg") && f.type.startsWith("image/");
      if (!tool.accept.includes(ext) && !image) {
        setError({ text: t("ws.wrongType", { name: f.name }) });
        continue;
      }
      if (f.size > LIMITS.mb * 1024 * 1024) {
        setError({ text: t("ws.tooBig", { name: f.name, mb: LIMITS.mb }) });
        continue;
      }
      ok.push(f);
    }
    if (!ok.length) return;
    const next = tool.multiple ? [...(base ?? items), ...ok.map((file) => ({ id: uid(), file }))] : [{ id: uid(), file: ok[0] }];
    const maxFiles = tool.mode === "compare" ? 2 : LIMITS.files;
    if (next.length > maxFiles) {
      setError({ text: t("ws.tooMany", { n: maxFiles }) });
      next.length = maxFiles;
    }
    setItems(next);
    setStage("work");
  }, [items, t, tool]);

  useEffect(() => clearHandoff(), []);

  // Once the page has settled, load what this tool runs on, so it also works
  // offline. The imports match the ones each stage makes when it runs.
  useEffect(() => {
    const code =
      tool.mode === "pages" ? () => import("@/lib/pdf/organize")
      : tool.mode === "editor" ? () => prepareEditor(tool.id)
      : tool.mode === "compare" ? prepareCompare
      : tool.mode === "chat" ? prepareChat
      : () => import("@/lib/pdf/run").then((m) => m.prepare(tool.id));
    const ai = !!tool.ai && tool.mode !== "chat";
    const timer = setTimeout(() => void import("@/lib/offline").then((m) => m.warm(tool.id, ai ? () => Promise.all([code(), prepareAi()]) : code)).catch(() => {}), 1500);
    return () => clearTimeout(timer);
  }, [tool.id, tool.mode, tool.ai]);

  // PDF/A: resolution and text layer only matter when some page has to become an image.
  const pdfaLevel = tool.id === "pdfToPdfa" ? String(options.pdfaLevel) : null;
  useEffect(() => {
    if (!pdfaLevel) return;
    let live = true;
    void import("@/lib/pdf/pdfa").then(async (m) => {
      const level = m.PDFA_LEVELS.find((l) => l === pdfaLevel) ?? "2b";
      // One file at a time, stopping at the first that needs rendering; a newer run cancels this one.
      const raster = await m.pdfaPreflight(files, level, () => live);
      if (raster !== undefined) setOptions((o) => (o.pdfaRaster === raster ? o : { ...o, pdfaRaster: raster }));
    });
    return () => {
      live = false;
    };
  }, [pdfaLevel, files]);

  // A file that can't be opened leaves the list, and the reason is shown.
  const drop = useCallback(async (id: string, file: File, e: unknown) => {
    setError(problem(await fileError(e, file)));
    setItems((list) => list.filter((i) => i.id !== id));
  }, [problem]);

  // Page tools: one card per page of every file. Edits to pages that were
  // already listed survive adding more files.
  useEffect(() => {
    if (tool.mode !== "pages" || !items.length) return;
    let live = true;
    (async () => {
      const built: PageItem[] = [];
      let failed = false;
      for (let fi = 0; fi < items.length; fi++) {
        try {
          const n = await pageCount(items[fi].file);
          for (let p = 0; p < n; p++) built.push({ key: `${items[fi].id}:${p}`, file: fi, page: p, rotate: 0 });
        } catch (e) {
          failed = true;
          if (live) void drop(items[fi].id, items[fi].file, e);
        }
      }
      // Dropping a file re-runs this with the files that are left.
      if (!live || failed) return;
      setOriginal(built);
      setPages((prev) => {
        const existing = new Map(prev.map((p) => [p.key, p]));
        const kept = built.map((p) => ({ ...(existing.get(p.key) ?? p), file: p.file }));
        // Order from earlier reordering wins; new pages go at the end.
        const order = prev.filter((p) => p.blank || kept.some((k) => k.key === p.key)).map((p) => p.key);
        const fresh = kept.filter((k) => !order.includes(k.key));
        const byKey = new Map([...prev, ...kept].map((p) => [p.key, p]));
        return [...order.map((k) => byKey.get(k)!), ...fresh];
      });
    })();
    return () => {
      live = false;
    };
  }, [items, tool.mode, drop]);

  const reset = () => {
    run.current++;
    setItems([]);
    setPages([]);
    setSelected(new Set());
    setOutputs([]);
    setError(null);
    setUrl("");
    setStage("select");
  };

  // Files dropped or pasted anywhere, at any stage. On the result screen
  // they start a new run; while one is running they're ignored.
  const over = useFileIntake((incoming) => {
    if (stage === "busy") return;
    if (stage === "done") {
      reset();
      void addFiles(incoming, []);
    } else void addFiles(incoming);
  });
  const dropHint = over && (
    <div className="pointer-events-none fixed inset-0 z-50 grid place-items-center bg-[color-mix(in_oklab,var(--bg)_70%,transparent)]">
      <p className="rounded-xl border border-dashed border-ink bg-surface px-6 py-4 text-[16px] font-medium shadow-card">{t("ws.dropActive")}</p>
    </div>
  );

  const fail = (e: unknown) => {
    // Typed errors (src/lib/pdf/errors.ts) name the file; a lone file is the one to blame otherwise.
    setError(problem(e, files.length === 1 ? files[0].name : undefined));
    setStage(items.length || url ? "work" : "select");
  };

  const execute = async (job: (p: Progress) => Promise<Output[]>) => {
    const ticket = ++run.current;
    setError(null);
    setProgress({ value: 0 });
    setStage("busy");
    try {
      const out = await job((done, total) => ticket === run.current && setProgress((p) => ({ ...p, value: total ? Math.min(1, done / total) : 0 })));
      if (ticket !== run.current) return;
      if (!out.length) throw new Error(t("res.error"));
      setOutputs(out);
      setStage("done");
      if (user) postJson("/api/history", { tool: tool.id, fileName: files[0]?.name ?? url }).catch(() => {});
    } catch (e) {
      if (ticket === run.current) fail(e);
    }
  };

  const validate = (): string | null => {
    if (tool.id === "protect") {
      if (!String(options.password ?? "")) return t("ws.passwordEmpty");
      if (options.password !== options.confirmPassword) return t("ws.passwordMismatch");
      const max = passwordTooLong(String(options.password));
      if (max !== null) return t("ws.passwordTooLong", { max });
    }
    if (tool.minFiles && files.length < tool.minFiles) return t("ws.needMore", { n: tool.minFiles });
    if (tool.id === "extract" && selected.size === 0) return t("ws.pickPages");
    if (tool.id === "remove" && (selected.size === 0 || selected.size >= pages.length)) return t("ws.pickPagesRemove");
    if (tool.runtime !== "browser" && typeof navigator !== "undefined" && !navigator.onLine) return t("ws.offline");
    return null;
  };

  // Office → PDF (src/lib/office/route.ts): LibreOffice once the user has agreed
  // to its one-time download, after a reload when the page must become
  // cross-origin isolated first; the print route otherwise.
  const convertOffice = async (job: Job) => {
    setError(null);
    const { officeRoute, officeEnv, officeConsented, consentToOffice } = await import("@/lib/office/route");
    if (job.agreed) consentToOffice();
    const route = officeRoute(String(job.options.fidelity), job.files.map((f) => f.name), await officeEnv(job.reloaded));
    if (route === "unavailable") return setError({ text: t("ws.officeReload") });
    if (route !== "print" && !job.agreed && !officeConsented()) return setAsk(job);
    if (route === "reload") {
      try {
        const { saveJob } = await import("@/lib/resume");
        await saveJob({ tool: tool.id, files: job.files, options: job.options, agreed: job.agreed });
        location.reload();
        return;
      } catch {
        // Nowhere to keep the files over a reload: carry on as if it had happened and not helped.
        return convertOffice({ ...job, reloaded: true });
      }
    }
    void execute(async (progress) => {
      const { runTool } = await import("@/lib/pdf/run");
      return runTool(tool.id, job.files, { ...job.options, fidelity: route === "print" ? "standard" : job.options.fidelity }, progress);
    });
  };

  // Back from that reload: the job's files and options are put back, and once
  // they show, it carries on by itself (a failure then leaves them in place).
  useEffect(() => {
    if (!office) return;
    let live = true;
    import("@/lib/resume")
      .then(async ({ peekJob, clearJob }) => {
        const job = await peekJob(tool.id);
        if (!live || !job) return;
        await clearJob(tool.id);
        setItems(job.files.map((file) => ({ id: uid(), file })));
        setOptions(job.options);
        setStage("work");
        setResumed({ files: job.files, options: job.options, reloaded: true, agreed: job.agreed });
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [office, tool.id]);
  const resume = useEffectEvent((job: Job) => void convertOffice(job));
  useEffect(() => {
    if (resumed) resume(resumed);
  }, [resumed]);

  const start = () => {
    const problem = validate();
    if (problem) {
      setError({ text: problem });
      return;
    }
    if (office) {
      void convertOffice({ files, options, reloaded: false });
      return;
    }
    if (tool.mode === "pages") {
      void execute(async () => {
        const org = await import("@/lib/pdf/organize");
        const stem = files[0].name.replace(/\.pdf$/i, "");
        if (tool.id === "extract") {
          const chosen = pages.filter((p) => selected.has(p.key));
          if (options.separate) return org.extractSeparate(files[0], chosen.map((p) => p.page));
          return [{ name: `${stem}-extracted.pdf`, blob: await org.buildFromPlan(files, chosen) }];
        }
        // Rotate: one PDF back for each file in.
        if (tool.id === "rotate" && files.length > 1) {
          const { byFile } = await import("@/lib/pageplan");
          const plans = byFile(pages.map((p) => ({ ...p, rotate: (p.rotate + turn) % 360 })), files.length);
          return Promise.all(files.map(async (f, fi) => ({ name: `${f.name.replace(/\.pdf$/i, "")}-rotated.pdf`, blob: await org.buildFromPlan([f], plans[fi]) })));
        }
        const plan = tool.id === "remove" ? pages.filter((p) => !selected.has(p.key)) : pages.map((p) => ({ ...p, rotate: (p.rotate + turn) % 360 }));
        const suffix = tool.id === "remove" ? "trimmed" : tool.id === "rotate" ? "rotated" : "organised";
        return [{ name: `${stem}-${suffix}.pdf`, blob: await org.buildFromPlan(files, plan) }];
      });
      return;
    }
    void execute(async (progress) => {
      const { runTool } = await import("@/lib/pdf/run");
      return runTool(tool.id, files, { ...options, url }, progress, { page: tOr("ws.page", "Page {n}"), pageOf: tOr("ws.processingPage", "Page {n} of {total}"), nOf: tOr("fmt.nOfTotal", "{n} of {total}") });
    });
  };

  const needsChrome = caps && (
    (tool.id === "htmlToPdf" && !caps.chrome) ||
    (tool.runtime === "server" && tool.id !== "htmlToPdf" && !caps.chrome && !caps.libreoffice)
  );
  const unavailable = needsChrome ? t("ws.needsChrome") : null;

  // ── Render
  // Back to the first step once the last file has gone.
  const view = stage === "work" && !items.length && !url ? "select" : stage;
  if (view === "done") {
    return outputs[0]?.print
      ? <PrintResults outputs={outputs} onReset={reset} />
      : <Results tool={tool} outputs={outputs} onReset={reset} />;
  }

  const errorBox = error && <ErrorBox problem={error} toolId={tool.id} />;

  const printable = ask?.files.every((f) => LIGHT_OFFICE.includes(fileExt(f.name)));
  const consent = ask && (
    <section aria-labelledby="office-consent" className="rise mx-auto mb-5 max-w-[760px] rounded-xl border border-line bg-surface p-5">
      <p id="office-consent" className="text-[16px] font-medium">{t("ws.officeConsentTitle")}</p>
      <p className="mt-1 text-[15px] text-ink-2">{t("ws.officeConsentBody")}</p>
      <div className="mt-4 flex flex-wrap gap-2">
        <button className="btn btn-primary" autoFocus onClick={() => { setAsk(null); void convertOffice({ ...ask, agreed: true }); }}>
          <Download size={18} /> {t("ws.officeConsentYes")}
        </button>
        {printable ? (
          <button className="btn btn-quiet" onClick={() => { setAsk(null); void convertOffice({ ...ask, options: { ...ask.options, fidelity: "standard" } }); }}>
            {t("ws.officeConsentPrint")}
          </button>
        ) : (
          <button className="btn btn-quiet" onClick={() => setAsk(null)}>{t("ws.officeConsentLater")}</button>
        )}
      </div>
    </section>
  );

  const warn = unavailable && (
    <p className="mx-auto mb-5 flex max-w-[760px] items-start gap-2 rounded-xl border border-line bg-surface p-4 text-[14px] text-ink-2">
      <AlertTriangle size={16} className="mt-0.5 shrink-0" /> {unavailable}
    </p>
  );

  if (view === "busy") {
    return (
      <div className="mx-auto flex max-w-[520px] flex-col items-center py-16 text-center" aria-live="polite">
        <Loader2 size={28} className="animate-spin text-muted" strokeWidth={1.75} />
        <p className="mt-5 text-[17px] font-medium tracking-[-0.01em]">{t("ws.processing")}</p>
        {progress.label && <p className="mt-1 text-[14px] text-muted">{progress.label}</p>}
        <div className="mt-6 h-1 w-full overflow-hidden rounded-full bg-line">
          <div className="h-full rounded-full bg-ink transition-[width] duration-300" style={{ width: `${Math.max(4, progress.value * 100)}%` }} />
        </div>
        <p className="eyebrow mt-2.5">{Math.round(progress.value * 100)}%</p>
        <button className="btn btn-quiet btn-sm mt-6" onClick={() => { run.current++; setStage("work"); }}>{t("ws.cancel")}</button>
      </div>
    );
  }

  // URL tool: an address field instead of (or as well as) a dropzone.
  if (tool.mode === "url" && view === "select") {
    return (
      <div>
        {warn}
        {errorBox}
        <form className="mx-auto flex max-w-[760px] flex-col gap-3 rounded-2xl border border-line bg-surface p-3 sm:flex-row"
          onSubmit={(e) => { e.preventDefault(); if (url.trim()) setStage("work"); }}>
          <label className="sr-only" htmlFor="url">{t("ws.urlLabel")}</label>
          <input id="url" type="url" inputMode="url" required className="field h-12 flex-1 text-[16px]" placeholder={t("ws.urlPlaceholder")} value={url} onChange={(e) => setUrl(e.target.value)} />
          <button className="btn btn-lg btn-primary">{t("tool.htmlToPdf.action")}</button>
        </form>
        <p className="my-6 text-center text-[14px] text-muted">{t("ws.orHtmlFile")}</p>
        <Dropzone tool={tool} onFiles={addFiles} over={over} />
      </div>
    );
  }

  if (view === "select") {
    return (
      <div>
        {warn}
        {errorBox}
        {tool.mode === "scan" && (
          <div className="mx-auto mb-6 flex max-w-[760px] justify-center">
            <Scanner onCapture={(f) => addFiles([f])} />
          </div>
        )}
        <Dropzone tool={tool} onFiles={addFiles} over={over} />
        {tool.id === "htmlToPdf" && <PasteHtml onFile={(f) => void addFiles([f])} />}
      </div>
    );
  }

  // Compare shows its result as soon as two files are in.
  if (tool.mode === "compare") {
    return (
      <div>
        {dropHint}
        {errorBox}
        <FileBoard items={items} onChange={(n) => { setItems(n); if (!n.length) setStage("select"); }} sortable>
          {items.length < 2 && <Dropzone tool={tool} onFiles={addFiles} compact />}
        </FileBoard>
        <div className="mt-8">
          {items.length === 2 ? (
            <CompareView key={`${items[0].id}:${items[1].id}`} a={files[0]} b={files[1]}
              onError={(e, file) => { const item = items.find((i) => i.file === file); if (item) void drop(item.id, file, e); }} />
          ) : <p className="text-center text-muted">{t("ws.needMore", { n: 2 })}</p>}
        </div>
      </div>
    );
  }

  // Chat reads the file as soon as it's in, and answers questions about it.
  if (tool.mode === "chat") {
    return (
      <div>
        {dropHint}
        {errorBox}
        <FileBoard items={items} onChange={(n) => { setItems(n); if (!n.length) reset(); }} sortable={false} />
        <div className="mt-6">
          <ChatView key={items[0].id} file={files[0]} models={tool.ai ?? []} options={options} defs={tool.options}
            onOption={(k, v) => setOptions((o) => ({ ...o, [k]: v }))} onError={(e) => void drop(items[0].id, files[0], e)} />
        </div>
      </div>
    );
  }

  if (tool.mode === "editor") {
    return (
      <div>
        {dropHint}
        {errorBox}
        {tool.options.length > 0 && (
          <div className="mb-4 max-w-[420px]"><Options defs={tool.options} values={options} onChange={(k, v) => setOptions((o) => ({ ...o, [k]: v }))} /></div>
        )}
        <Editor key={items[0].id} toolId={tool.id} file={files[0]} options={options} actionLabel={t(`tool.${tool.id}.action`)} onRun={execute}
          onError={(e) => void drop(items[0].id, files[0], e)} />
      </div>
    );
  }

  const board =
    tool.mode === "pages" ? (
      <PageBoard mode={tool.id} files={files} pages={pages} setPages={setPages} selected={selected} setSelected={setSelected} turn={turn} original={original}
        toolbar={tool.multiple ? <Dropzone tool={tool} onFiles={addFiles} compact /> : null} />
    ) : tool.mode === "url" ? (
      <div className="card flex items-center gap-3 p-5">
        <span className="min-w-0 flex-1 truncate text-[16px] font-medium">{files[0]?.name ?? url}</span>
        <button className="btn btn-quiet btn-sm" onClick={reset}>{t("res.startOver")}</button>
      </div>
    ) : (
      <FileBoard items={items} onChange={(n) => { setItems(n); if (!n.length) reset(); }} sortable={["merge", "jpgToPdf", "scan"].includes(tool.id)}>
        {tool.multiple && <Dropzone tool={tool} onFiles={addFiles} compact />}
        {tool.mode === "scan" && <Scanner onCapture={(f) => addFiles([f])} />}
      </FileBoard>
    );

  return (
    <div>
      {dropHint}
      {warn}
      {errorBox}
      {consent}
      <div className="grid gap-6 lg:grid-cols-[1fr_340px]">
        <div className="min-w-0">{board}</div>
        <aside className="card h-max p-5 lg:sticky lg:top-[88px]">
          <p className="mb-5 text-[14px] font-medium">{t("ws.options")}</p>
          <Options defs={tool.options} values={options} onChange={(k, v) => setOptions((o) => ({ ...o, [k]: v }))} />
          {tool.ai && <AiModels models={tool.ai} value={String(options.aiModel ?? "")} onChange={(v) => setOptions((o) => ({ ...o, aiModel: v }))} />}
          <button className="btn btn-primary btn-lg mt-6 hidden w-full lg:inline-flex" onClick={start}>
            {t(`tool.${tool.id}.action`)} <ArrowRight size={18} className="rtl:rotate-180" />
          </button>
        </aside>
      </div>
      {/* Phones: the action stays in reach at the bottom. */}
      <div className="sticky bottom-0 z-30 -mx-4 mt-6 border-t border-line bg-[color-mix(in_oklab,var(--bg)_92%,transparent)] px-4 py-3 backdrop-blur lg:hidden">
        <button className="btn btn-primary btn-lg w-full" onClick={start}>
          {t(`tool.${tool.id}.action`)} <ArrowRight size={18} className="rtl:rotate-180" />
        </button>
      </div>
    </div>
  );
}
