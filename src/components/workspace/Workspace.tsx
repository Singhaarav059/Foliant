"use client";

import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { AlertTriangle, ArrowRight, Download, Loader2, X } from "lucide-react";
import { useI18n } from "../I18n";
import type { Stamp } from "./StampPreview";
import { Dropzone, useFileIntake } from "./Dropzone";
import { FileBoard, type Item } from "./FileBoard";
import { Options } from "./Options";
import { StepTrail } from "./StepTrail";
import { Processing } from "./Processing";
import { useSplitHints } from "./splitHints";
import type { PageItem } from "./PageBoard";
import { AiModels, prepareAi } from "./AiModels";
import { ErrorBox, useProblem, type Problem } from "./ErrorBox";
import { peekHandoff, restoreHandoff } from "@/lib/handoff";
import { fileExt, humanSize, type Output, type Progress } from "@/lib/pdf/common";
import type { FileState, Track } from "@/lib/pdf/run";
import { overBudget } from "@/lib/budget";
import { fileError } from "@/lib/pdf/errors";
import { markUnrestricted, PERMISSIONS, protectProblem } from "@/lib/pdf/password";
import { pageCount } from "@/lib/pdf/thumbs";
import { defaultOptions, LIGHT_OFFICE, LIMITS, toolById, type ToolId } from "@/lib/tools";

type Stage = "select" | "work" | "busy" | "done";
type Caps = { chrome: boolean; libreoffice: boolean };
type Job = { files: File[]; options: Record<string, unknown>; reloaded: boolean; agreed?: boolean };

const uid = () => crypto.randomUUID();

// Each mode's view is loaded when a tool uses it (P3-03), so a tool that only
// lists files doesn't carry the editor, the page board or the scanner.
// One import() per view, shared by the view and by the offline warm-up: Turbopack
// gives each import() call its own chunk, and warming a copy the page never
// loads left the view out of the offline cache.
const load = {
  Editor: () => import("./Editor"),
  PageBoard: () => import("./PageBoard"),
  Scanner: () => import("./Scanner"),
  CompareView: () => import("./CompareView"),
  SignatureCheck: () => import("./SignatureCheck"),
  ChatView: () => import("./ChatView"),
  ListenView: () => import("./ListenView"),
  PrintResults: () => import("./PrintResults"),
  PasteHtml: () => import("./PasteHtml"),
  Results: () => import("./Results"),
  StampPreview: () => import("./StampPreview"),
};
const Editor = dynamic(() => load.Editor().then((m) => m.Editor), { ssr: false });
const PageBoard = dynamic(() => load.PageBoard().then((m) => m.PageBoard), { ssr: false });
const Scanner = dynamic(() => load.Scanner().then((m) => m.Scanner), { ssr: false });
const CompareView = dynamic(() => load.CompareView().then((m) => m.CompareView), { ssr: false });
const SignatureCheck = dynamic(() => load.SignatureCheck().then((m) => m.SignatureCheck), { ssr: false });
const ChatView = dynamic(() => load.ChatView().then((m) => m.ChatView), { ssr: false });
const ListenView = dynamic(() => load.ListenView().then((m) => m.ListenView), { ssr: false });
const PrintResults = dynamic(() => load.PrintResults().then((m) => m.PrintResults), { ssr: false });
const PasteHtml = dynamic(() => load.PasteHtml().then((m) => m.PasteHtml), { ssr: false });
const Results = dynamic(() => load.Results().then((m) => m.Results), { ssr: false });
const StampPreview = dynamic(() => load.StampPreview().then((m) => m.StampPreview), { ssr: false });
const prepareEditor = (id: ToolId) => load.Editor().then((m) => m.prepareEditor(id));
const prepareCompare = () => load.CompareView().then((m) => m.prepareCompare());
const prepareCheck = () => load.SignatureCheck().then((m) => m.prepareCheck());
const prepareChat = () => load.ChatView().then((m) => m.prepareChat());
const prepareListen = () => load.ListenView().then((m) => m.prepareListen());
// The tools with a live preview (StampPreview.tsx).
const STAMPS: string[] = ["watermark", "pageNumbers", "headerFooter"];

// `preset`: options to start from instead of the defaults (a landing page's, see src/lib/landings.ts).
export function Workspace({ toolId, preset }: { toolId: ToolId; preset?: Record<string, unknown> }) {
  const tool = toolById(toolId);
  const { t, tOr } = useI18n();
  const problem = useProblem();
  // Files handed over from the previous tool's result, or from the browser
  // add-on, start the workspace pre-filled, when this tool takes them.
  const handed = () => (peekHandoff() ?? []).filter((f) => tool.accept.includes(fileExt(f.name)));
  const [items, setItems] = useState<Item[]>(() => handed().map((file) => ({ id: uid(), file })));
  const [options, setOptions] = useState<Record<string, unknown>>(() => ({ ...defaultOptions(tool), ...preset }));
  const [stage, setStage] = useState<Stage>(() => (handed().length ? "work" : "select"));
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
  // The running job's controller: Cancel, a reset or leaving the page aborts it,
  // which stops its engines and frees what they hold (src/lib/pdf/run.ts).
  const abort = useRef<AbortController | null>(null);
  const stop = () => {
    run.current++;
    abort.current?.abort();
    abort.current = null;
  };
  useEffect(() => () => abort.current?.abort(), []);
  const files = useMemo(() => items.map((i) => i.file), [items]);
  // Rotate turns every page by the chosen angle, on top of each page's own turn.
  const turn = tool.id === "rotate" ? Number(options.angle) || 0 : 0;
  // Office → PDF in the static build, which has a fidelity choice.
  const office = tool.options.some((o) => o.key === "fidelity");
  const notes = useSplitHints(tool, files[0], options, setOptions);
  // More than this device comfortably holds at once: a warning, never a refusal.
  const heavy = useMemo(() => (tool.runtime === "browser" ? overBudget(files) : null), [files, tool.runtime]);
  // Each file's state in a batch, while it runs.
  const [fileStates, setFileStates] = useState<FileState[]>([]);

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
      // Tools that run on the device take any size; only the server has a cap.
      if (tool.runtime === "server" && f.size > LIMITS.mb * 1024 * 1024) {
        setError({ text: t("ws.tooBig", { name: f.name, mb: LIMITS.mb }) });
        continue;
      }
      ok.push(f);
    }
    if (!ok.length) return;
    const next = tool.multiple ? [...(base ?? items), ...ok.map((file) => ({ id: uid(), file }))] : [{ id: uid(), file: ok[0] }];
    const maxFiles = tool.mode === "compare" ? 2 : tool.runtime === "server" ? LIMITS.files : Infinity;
    if (next.length > maxFiles) {
      setError({ text: t("ws.tooMany", { n: maxFiles }) });
      next.length = maxFiles;
    }
    setItems(next);
    setStage("work");
  }, [items, t, tool]);

  // Files handed over before a full page load (from /{lang}/open, offline)
  // come from storage once the page is up.
  const restored = useEffectEvent((handed: File[]) => void (handed.length && addFiles(handed, [])));
  useEffect(() => void restoreHandoff(toolId).then(restored), [toolId]);

  // Once the page has settled, load what this tool runs on, so it also works
  // offline. The imports match the ones each stage makes when it runs.
  useEffect(() => {
    const engine =
      tool.mode === "pages" ? () => import("@/lib/pdf/organize")
      : tool.mode === "editor" ? () => prepareEditor(tool.id)
      : tool.mode === "compare" ? prepareCompare
      : tool.mode === "check" ? prepareCheck
      : tool.mode === "chat" ? prepareChat
      : tool.mode === "listen" ? prepareListen
      : () => import("@/lib/pdf/run").then((m) => m.prepare(tool.id));
    // The views this tool shows load on demand too (the dynamic imports above),
    // so they're fetched with its code, for offline use.
    const views = () => Promise.all([
      load.Results(), load.PrintResults(),
      tool.mode === "pages" ? load.PageBoard() : null,
      tool.mode === "scan" ? load.Scanner() : null,
      tool.id === "htmlToPdf" ? load.PasteHtml() : null,
      STAMPS.includes(tool.id) ? load.StampPreview() : null,
    ]);
    const code = () => Promise.all([engine(), views()]);
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
    stop();
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

  const execute = async (job: (p: Progress, signal: AbortSignal, track: Track) => Promise<Output[]>) => {
    stop();
    const ticket = run.current;
    const controller = (abort.current = new AbortController());
    setError(null);
    setProgress({ value: 0 });
    setFileStates(files.map(() => "wait"));
    const track: Track = (i, state) => ticket === run.current && setFileStates((list) => list.map((s, k) => (k === i ? state : s)));
    setStage("busy");
    try {
      const made = await job((done, total) => ticket === run.current && setProgress((p) => ({ ...p, value: total ? Math.min(1, done / total) : 0 })), controller.signal, track);
      const out = tool.id === "protect" || tool.id === "unlock" ? made : await markUnrestricted(files, made);
      if (ticket !== run.current) return;
      if (!out.length) throw new Error(t("res.error"));
      setOutputs(out);
      setStage("done");
    } catch (e) {
      if (ticket === run.current) fail(e);
    } finally {
      if (abort.current === controller) abort.current = null;
    }
  };

  const validate = (): string | null => {
    if (tool.id === "protect") {
      const problem = protectProblem({
        ...Object.fromEntries(PERMISSIONS.map((k) => [k, options[k] !== false])),
        openPassword: options.openPassword !== false, password: String(options.password ?? ""), confirmPassword: String(options.confirmPassword ?? ""), ownerPassword: String(options.ownerPassword ?? ""),
      });
      if (problem?.code === "passwordEmpty") return t("ws.passwordEmpty");
      if (problem?.code === "noRestriction") return t("ws.noRestriction");
      if (problem?.code === "passwordMismatch") return t("ws.passwordMismatch");
      if (problem?.code === "ownerSameAsOpen") return t("ws.ownerSameAsOpen");
      if (problem?.code === "passwordTooLong") return t("ws.passwordTooLong", { max: problem.max });
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
    void execute(async (progress, signal, track) => {
      const { runTool } = await import("@/lib/pdf/run");
      return runTool(tool.id, job.files, { ...job.options, fidelity: route === "print" ? "standard" : job.options.fidelity }, progress, undefined, signal, track);
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
          return [{ name: `${stem}-extracted.pdf`, blob: await org.buildFromPlan(files, chosen, { extract: true }) }];
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
    void execute(async (progress, signal, track) => {
      const { runTool } = await import("@/lib/pdf/run");
      return runTool(tool.id, files, { ...options, url }, progress, { page: tOr("ws.page", "Page {n}"), pageOf: tOr("ws.processingPage", "Page {n} of {total}"), nOf: tOr("fmt.nOfTotal", "{n} of {total}") }, signal, track);
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
  // Every stage below returns its own view; the step trail sits above them all.
  const body = (() => {
  if (view === "done") {
    return outputs[0]?.print
      ? <PrintResults outputs={outputs} onReset={reset} />
      : <Results tool={tool} outputs={outputs} onReset={reset} />;
  }

  const errorBox = error && <ErrorBox problem={error} toolId={tool.id} />;
  const heavyNote = heavy && (
    <p role="note" className="mx-auto mb-5 flex max-w-[760px] items-start gap-2 rounded-xl border border-line bg-surface p-4 text-[14px] text-ink-2">
      <AlertTriangle size={16} className="mt-0.5 shrink-0" /> {t("ws.bigBatch", { size: humanSize(heavy) })}
    </p>
  );

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
      <div className="mx-auto flex max-w-[520px] flex-col items-center py-8 text-center" aria-live="polite">
        <Processing tool={tool.id} value={progress.value} label={progress.label} />
        {fileStates.length > 1 && fileStates.some((st) => st !== "wait") && (
          <ul aria-label={t("ws.fileQueue")} className="mt-6 max-h-[40vh] w-full overflow-y-auto rounded-xl border border-line bg-surface text-start text-[14px]">
            {files.map((f, i) => (
              <li key={i} className="flex items-center gap-3 border-b border-line px-4 py-2 last:border-b-0">
                <span className="min-w-0 flex-1 truncate">{f.name}</span>
                <span className={`shrink-0 ${fileStates[i] === "fail" ? "text-danger" : fileStates[i] === "done" ? "text-success" : "text-muted"}`}>
                  {fileStates[i] === "work" ? <Loader2 size={14} className="me-1 inline animate-spin" /> : null}
                  {t(`ws.file.${fileStates[i] ?? "wait"}`)}
                </span>
              </li>
            ))}
          </ul>
        )}
        <button className="btn btn-quiet btn-sm mt-6" onClick={() => { stop(); setStage("work"); }}>{t("ws.cancel")}</button>
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

  // Read aloud shows the text in reading order as soon as the file is in.
  if (tool.mode === "listen") {
    return (
      <div>
        {dropHint}
        {errorBox}
        <FileBoard items={items} onChange={(n) => { setItems(n); if (!n.length) reset(); }} sortable={false} />
        <ListenView key={items[0].id} file={files[0]} onError={(e) => void drop(items[0].id, files[0], e)} />
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

  // Checking signatures is a report on the one file, shown as soon as it's in.
  if (tool.mode === "check") {
    return (
      <div>
        {dropHint}
        {errorBox}
        <FileBoard items={items} onChange={(n) => { setItems(n); if (!n.length) setStage("select"); }} sortable={false} />
        <div className="mt-8">
          {items[0] && <SignatureCheck key={items[0].id} file={files[0]} onError={(e) => void drop(items[0].id, files[0], e)} />}
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
          <div className="mb-4 max-w-[420px]"><Options restore defs={tool.options} values={options} onChange={(k, v) => setOptions((o) => ({ ...o, [k]: v }))} /></div>
        )}
        {/* Crop and redact take a batch: the first file is on the canvas, the rest get the same box or searches. */}
        {tool.multiple && (
          <ul aria-label={t("ws.fileQueue")} className="mb-4 flex flex-wrap items-center gap-2">
            <li><Dropzone tool={tool} onFiles={addFiles} compact /></li>
            {items.length > 1 && items.map((it) => (
              <li key={it.id} className="inline-flex max-w-[260px] items-center gap-1 rounded-lg border border-line bg-surface py-1 pe-1 ps-3 text-[13px]">
                <span className="truncate" title={it.file.name}>{it.file.name}</span>
                <button className="icon-btn h-7 w-7 shrink-0 hover:text-danger" aria-label={`${t("ws.remove")} ${it.file.name}`}
                  onClick={() => setItems((list) => list.filter((x) => x.id !== it.id))}>
                  <X size={14} />
                </button>
              </li>
            ))}
          </ul>
        )}
        {heavyNote}
        <Editor key={items[0].id} toolId={tool.id} file={files[0]} others={files.slice(1)} options={options} actionLabel={t(`tool.${tool.id}.action`)} onRun={execute}
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
      <FileBoard items={items} onChange={(n) => { setItems(n); if (!n.length) reset(); }} sortable={["merge", "jpgToPdf", "scan", "mix"].includes(tool.id)}>
        {tool.multiple && <Dropzone tool={tool} onFiles={addFiles} compact />}
        {tool.mode === "scan" && <Scanner onCapture={(f) => addFiles([f])} />}
      </FileBoard>
    );

  return (
    <div>
      {dropHint}
      {warn}
      {heavyNote}
      {errorBox}
      {consent}
      <div className="grid gap-6 lg:grid-cols-[1fr_340px]">
        <div className="min-w-0">
          {board}
          {STAMPS.includes(tool.id) && files[0] && <StampPreview key={items[0].id} tool={tool.id as Stamp} file={files[0]} options={options} />}
        </div>
        <aside className="card h-max p-5 lg:sticky lg:top-[88px]">
          <p className="mb-5 text-[14px] font-medium">{t("ws.options")}</p>
          <Options restore defs={tool.options} values={options} notes={notes} onChange={(k, v) => setOptions((o) => ({ ...o, [k]: v }))} />
          {tool.ai && <AiModels task={tool.id} models={tool.ai} value={String(options.aiModel ?? "")} onChange={(v) => setOptions((o) => ({ ...o, aiModel: v }))} />}
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
  })();
  return (
    <>
      <StepTrail view={view} mode={tool.mode} cat={tool.category} />
      {body}
    </>
  );
}
