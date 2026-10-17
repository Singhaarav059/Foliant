"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, ArrowRight, Loader2 } from "lucide-react";
import { useI18n } from "../I18n";
import { useUser, postJson } from "../User";
import { Dropzone } from "./Dropzone";
import { FileBoard, type Item } from "./FileBoard";
import { Options } from "./Options";
import { PageBoard, type PageItem } from "./PageBoard";
import { Editor } from "./Editor";
import { Scanner } from "./Scanner";
import { CompareView } from "./CompareView";
import { Results } from "./Results";
import { PrintResults } from "./PrintResults";
import { clearHandoff, peekHandoff } from "@/lib/handoff";
import { fileExt, type Output, type Progress } from "@/lib/pdf/common";
import { pageCount } from "@/lib/pdf/thumbs";
import { defaultOptions, LIMITS, toolById, type ToolId } from "@/lib/tools";

type Stage = "select" | "work" | "busy" | "done";
type Caps = { chrome: boolean; libreoffice: boolean };

const uid = () => crypto.randomUUID();

export function Workspace({ toolId }: { toolId: ToolId }) {
  const tool = toolById(toolId);
  const { t, tOr, href } = useI18n();
  const { user } = useUser();
  // Files handed over from the previous tool's result start the workspace pre-filled.
  const [items, setItems] = useState<Item[]>(() => (peekHandoff() ?? []).map((file) => ({ id: uid(), file })));
  const [options, setOptions] = useState<Record<string, unknown>>(() => defaultOptions(tool));
  const [stage, setStage] = useState<Stage>(() => (peekHandoff()?.length ? "work" : "select"));
  const [progress, setProgress] = useState<{ value: number; label?: string }>({ value: 0 });
  const [outputs, setOutputs] = useState<Output[]>([]);
  const [error, setError] = useState<{ text: string; unlock?: boolean } | null>(null);
  const [pages, setPages] = useState<PageItem[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [url, setUrl] = useState("");
  const [caps, setCaps] = useState<Caps | null>(null);
  const run = useRef(0);
  const files = useMemo(() => items.map((i) => i.file), [items]);

  useEffect(() => {
    if (tool.runtime === "browser") return;
    fetch("/api/capabilities").then((r) => r.json()).then(setCaps).catch(() => setCaps(null));
  }, [tool.runtime]);

  const addFiles = useCallback(async (incoming: File[]) => {
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
    const next = tool.multiple ? [...items, ...ok.map((file) => ({ id: uid(), file }))] : [{ id: uid(), file: ok[0] }];
    const maxFiles = tool.mode === "compare" ? 2 : LIMITS.files;
    if (next.length > maxFiles) {
      setError({ text: t("ws.tooMany", { n: maxFiles }) });
      next.length = maxFiles;
    }
    setItems(next);
    setStage("work");
  }, [items, t, tool]);

  useEffect(() => clearHandoff(), []);

  // Page tools: one card per page of every file. Edits to pages that were
  // already listed survive adding more files.
  useEffect(() => {
    if (tool.mode !== "pages" || !items.length) return;
    let live = true;
    (async () => {
      const built: PageItem[] = [];
      for (let fi = 0; fi < items.length; fi++) {
        try {
          const n = await pageCount(items[fi].file);
          for (let p = 0; p < n; p++) built.push({ key: `${items[fi].id}:${p}`, file: fi, page: p, rotate: 0 });
        } catch {
          if (live) setError({ text: t("ws.encrypted", { name: items[fi].file.name }), unlock: true });
        }
      }
      if (!live) return;
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
  }, [items, tool.mode, t]);

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

  const fail = (e: unknown) => {
    // Errors carry a code because class names don't survive minification.
    const { code, fileName } = (e ?? {}) as { code?: string; fileName?: string };
    if (code === "encrypted" || /is encrypted|PasswordException/i.test(String(e))) setError({ text: t("ws.encrypted", { name: fileName ?? "" }), unlock: true });
    else if (code === "wrong_password") setError({ text: t("ws.wrongPassword") });
    else if (code === "office_isolation") setError({ text: t("ws.officeReload") });
    else if (code === "office_memory") setError({ text: t("ws.officeMemory") });
    else if (code === "redaction_leak") setError({ text: t("ws.redactionLeak") });
    else setError({ text: e instanceof Error ? e.message : String(e) });
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
    }
    if (tool.minFiles && files.length < tool.minFiles) return t("ws.needMore", { n: tool.minFiles });
    if (tool.id === "extract" && selected.size === 0) return t("ws.pickPages");
    if (tool.id === "remove" && (selected.size === 0 || selected.size >= pages.length)) return t("ws.pickPagesRemove");
    if (tool.runtime !== "browser" && typeof navigator !== "undefined" && !navigator.onLine) return t("ws.offline");
    return null;
  };

  const start = () => {
    const problem = validate();
    if (problem) {
      setError({ text: problem });
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
        const plan = tool.id === "remove" ? pages.filter((p) => !selected.has(p.key)) : pages;
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
  if (stage === "done") {
    return outputs[0]?.print
      ? <PrintResults outputs={outputs} onReset={reset} />
      : <Results tool={tool} outputs={outputs} onReset={reset} />;
  }

  const errorBox = error && (
    <div role="alert" className="rise mx-auto mb-5 flex max-w-[760px] items-start gap-3 rounded-xl border border-[color-mix(in_oklab,var(--danger)_30%,var(--line))] bg-[color-mix(in_oklab,var(--danger)_5%,var(--surface))] p-4 text-[15px]">
      <AlertTriangle size={18} className="mt-0.5 shrink-0 text-danger" />
      <span className="flex-1">{error.text}</span>
      {error.unlock && (
        <Link href={href("/unlock-pdf")} className="flex shrink-0 items-center gap-1 font-medium text-ink underline decoration-line-strong underline-offset-4 hover:decoration-ink">
          {t("tool.unlock.name")} <ArrowRight size={15} />
        </Link>
      )}
    </div>
  );

  const warn = unavailable && (
    <p className="mx-auto mb-5 flex max-w-[760px] items-start gap-2 rounded-xl border border-line bg-surface p-4 text-[14px] text-ink-2">
      <AlertTriangle size={16} className="mt-0.5 shrink-0" /> {unavailable}
    </p>
  );

  if (stage === "busy") {
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
  if (tool.mode === "url" && stage === "select") {
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
        <Dropzone tool={tool} onFiles={addFiles} />
      </div>
    );
  }

  if (stage === "select") {
    return (
      <div>
        {warn}
        {errorBox}
        {tool.mode === "scan" && (
          <div className="mx-auto mb-6 flex max-w-[760px] justify-center">
            <Scanner onCapture={(f) => addFiles([f])} />
          </div>
        )}
        <Dropzone tool={tool} onFiles={addFiles} />
      </div>
    );
  }

  // Compare shows its result as soon as two files are in.
  if (tool.mode === "compare") {
    return (
      <div>
        {errorBox}
        <FileBoard items={items} onChange={(n) => { setItems(n); if (!n.length) setStage("select"); }} sortable>
          {items.length < 2 && <Dropzone tool={tool} onFiles={addFiles} compact />}
        </FileBoard>
        <div className="mt-8">{items.length === 2 ? <CompareView a={files[0]} b={files[1]} /> : <p className="text-center text-muted">{t("ws.needMore", { n: 2 })}</p>}</div>
      </div>
    );
  }

  if (tool.mode === "editor") {
    return (
      <div>
        {errorBox}
        {tool.options.length > 0 && (
          <div className="mb-4 max-w-[420px]"><Options defs={tool.options} values={options} onChange={(k, v) => setOptions((o) => ({ ...o, [k]: v }))} /></div>
        )}
        <Editor key={items[0].id} toolId={tool.id} file={files[0]} options={options} actionLabel={t(`tool.${tool.id}.action`)} onRun={execute} />
      </div>
    );
  }

  const board =
    tool.mode === "pages" ? (
      <PageBoard mode={tool.id} files={files} pages={pages} setPages={setPages} selected={selected} setSelected={setSelected}
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
      {warn}
      {errorBox}
      <div className="grid gap-6 lg:grid-cols-[1fr_340px]">
        <div className="min-w-0">{board}</div>
        <aside className="card h-max p-5 lg:sticky lg:top-[88px]">
          <p className="mb-5 text-[14px] font-medium">{t("ws.options")}</p>
          <Options defs={tool.options} values={options} onChange={(k, v) => setOptions((o) => ({ ...o, [k]: v }))} />
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
