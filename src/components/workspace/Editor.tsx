"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  MousePointer2, Type, ImagePlus, Square, Circle, Minus, Pencil, Highlighter, Eraser, Undo2, Redo2, Trash2,
  ChevronLeft, ChevronRight, ZoomIn, ZoomOut, Signature as SignatureIcon, CalendarDays, Search, ScanEye, Crop as CropIcon,
  TextCursorInput, SquareCheck, Copy, Bold,
} from "lucide-react";
import { useI18n } from "../I18n";
import { SignaturePad, type SignatureImage } from "./SignaturePad";
import { thumbUrl, pageSizes, docFor } from "@/lib/pdf/thumbs";
import type { EditorItem, FieldInfo, FracRect } from "@/lib/pdf/edit";
import type { Output, Progress } from "@/lib/pdf/common";
import type { ToolId } from "@/lib/tools";

type EdTool = "select" | "text" | "image" | "rect" | "ellipse" | "line" | "path" | "highlight" | "whiteout" | "redact" | "crop" | "textField" | "checkbox" | "place";
type Size = { w: number; h: number };
// Marks from a search keep the text matched, the search they came from (and
// its pattern, to run it again on the result) and how many boxes that text
// got in it, so the run can tell which texts are fully marked.
type Mark = { id: string; page: number; rect: FracRect; term?: string; search?: string; pattern?: RegExp; of?: number };

const COLORS = ["#111827", "#d33f6a", "#2f6fed", "#12a37f", "#e2662b", "#7b4fe0", "#ffffff"];
const uid = () => crypto.randomUUID();
const PRESET_NAMES = ["emails", "phones", "numbers"] as const;

function useHistory<T>(initial: T) {
  const [stack, setStack] = useState<{ past: T[]; now: T; future: T[] }>({ past: [], now: initial, future: [] });
  const set = useCallback((next: T | ((v: T) => T), record = true) => {
    setStack((s) => {
      const value = typeof next === "function" ? (next as (v: T) => T)(s.now) : next;
      return record ? { past: [...s.past.slice(-80), s.now], now: value, future: [] } : { ...s, now: value };
    });
  }, []);
  const undo = useCallback(() => setStack((s) => (s.past.length ? { past: s.past.slice(0, -1), now: s.past[s.past.length - 1], future: [s.now, ...s.future] } : s)), []);
  const redo = useCallback(() => setStack((s) => (s.future.length ? { past: [...s.past, s.now], now: s.future[0], future: s.future.slice(1) } : s)), []);
  return { value: stack.now, set, undo, redo, canUndo: stack.past.length > 0, canRedo: stack.future.length > 0 };
}

export function Editor({
  toolId, file, options, actionLabel, onRun,
}: {
  toolId: ToolId; file: File; options: Record<string, unknown>; actionLabel: string;
  onRun: (job: (p: Progress) => Promise<Output[]>) => void;
}) {
  const { t } = useI18n();
  const [sizes, setSizes] = useState<Size[]>([]);
  const [page, setPage] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [fit, setFit] = useState(640);
  const [rendered, setRendered] = useState<{ key: string; url: string } | null>(null);
  const items = useHistory<EditorItem[]>([]);
  const marks = useHistory<Mark[]>([]);
  const [crops, setCrops] = useState<Map<number, FracRect>>(new Map());
  const [tool, setTool] = useState<EdTool>(toolId === "redact" ? "redact" : toolId === "crop" ? "crop" : toolId === "sign" ? "place" : "select");
  const [sel, setSel] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [style, setStyle] = useState({ color: "#111827", fill: null as string | null, stroke: 2, fontSize: 16, bold: false });
  const [pad, setPad] = useState<null | "signature" | "initials">(null);
  const [stamp, setStamp] = useState<{ image?: SignatureImage; text?: string } | null>(null);
  const [pendingImage, setPendingImage] = useState<SignatureImage | null>(null);
  const [fields, setFields] = useState<FieldInfo[]>([]);
  const [values, setValues] = useState<Record<string, string | boolean | string[]>>({});
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<number | null>(null);
  const [matchCase, setMatchCase] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const stage = useRef<HTMLDivElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const imageInput = useRef<HTMLInputElement>(null);
  const drag = useRef<null | { kind: "new" | "move" | "resize" | "crop-move" | "crop-resize"; id?: string; x0: number; y0: number; orig?: FracRect; handle?: string }>(null);

  useEffect(() => {
    pageSizes(file).then(setSizes).catch(() => setSizes([]));
    if (toolId === "forms") {
      import("@/lib/pdf/edit").then(({ readFields }) => readFields(file)).then((f) => {
        setFields(f);
        setValues(Object.fromEntries(f.map((x) => [x.name, x.value])));
      }).catch(() => setFields([]));
    }
  }, [file, toolId]);

  // Fit the page to the available width.
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setFit(Math.max(260, Math.min(900, el.clientWidth - 32))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const size = sizes[page];
  const width = Math.round(fit * zoom);
  const height = size ? Math.round((width * size.h) / size.w) : Math.round(width * 1.414);
  const ptToPx = size ? width / size.w : 1;

  const imgKey = `${page}:${width}`;
  const img = rendered?.key === imgKey ? rendered.url : null;
  useEffect(() => {
    let live = true;
    thumbUrl(file, page, width).then((r) => live && setRendered({ key: `${page}:${width}`, url: r.url })).catch(() => {});
    return () => {
      live = false;
    };
  }, [file, page, width]);

  const pageItems = items.value.filter((i) => i.page === page);
  const pageMarks = marks.value.filter((m) => m.page === page);
  const selected = items.value.find((i) => i.id === sel) ?? null;
  const cropRect = crops.get(options.cropScope === "current" ? page : -1) ?? null;

  const frac = (e: { clientX: number; clientY: number }) => {
    const r = stage.current!.getBoundingClientRect();
    return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) };
  };

  const patch = (id: string, p: Partial<EditorItem>, record = true) => items.set((list) => list.map((i) => (i.id === id ? { ...i, ...p } : i)), record);

  const placeImage = (img: SignatureImage, x: number, y: number, kind: "image" = "image") => {
    const w = img.ratio > 1 ? 0.14 : 0.26;
    const h = (w * img.ratio * (size?.w ?? 1)) / (size?.h ?? 1.414);
    const it: EditorItem = { id: uid(), page, kind, x: Math.max(0, x - w / 2), y: Math.max(0, y - h / 2), w, h, image: img.url };
    items.set((l) => [...l, it]);
    setSel(it.id);
  };

  const onDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    // Stops the browser moving focus to the page on mousedown, which would
    // immediately blur a text box created by this same press.
    e.preventDefault();
    const p = frac(e);
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    if (tool === "place" && stamp) {
      if (stamp.image) placeImage(stamp.image, p.x, p.y);
      else if (stamp.text) {
        const it: EditorItem = { id: uid(), page, kind: "text", x: p.x, y: p.y - 0.01, w: 0.2, h: 0.03, text: stamp.text, fontSize: style.fontSize, color: style.color };
        items.set((l) => [...l, it]);
        setSel(it.id);
      }
      setStamp(null);
      setTool("select");
      return;
    }
    if (tool === "image" && pendingImage) {
      placeImage(pendingImage, p.x, p.y);
      setPendingImage(null);
      setTool("select");
      return;
    }
    if (tool === "text") {
      const it: EditorItem = { id: uid(), page, kind: "text", x: p.x, y: p.y, w: 0.25, h: 0.04, text: "", fontSize: style.fontSize, color: style.color, bold: style.bold };
      items.set((l) => [...l, it]);
      setSel(it.id);
      setEditing(it.id);
      setTool("select");
      return;
    }
    if (tool === "select" || tool === "place") {
      setSel(null);
      setEditing(null);
      return;
    }
    if (tool === "crop") {
      drag.current = { kind: "new", x0: p.x, y0: p.y };
      setCrops((m) => new Map(m).set(options.cropScope === "current" ? page : -1, { x: p.x, y: p.y, w: 0, h: 0 }));
      return;
    }
    if (tool === "redact") {
      const id = uid();
      marks.set((l) => [...l, { id, page, rect: { x: p.x, y: p.y, w: 0, h: 0 } }]);
      drag.current = { kind: "new", id, x0: p.x, y0: p.y };
      return;
    }
    const kind = tool as EditorItem["kind"];
    const it: EditorItem = {
      id: uid(), page, kind, x: p.x, y: p.y, w: 0, h: 0,
      color: tool === "highlight" ? "#facc15" : style.color, fill: tool === "rect" || tool === "ellipse" ? style.fill : null, stroke: style.stroke,
      points: tool === "path" || tool === "line" ? [[p.x, p.y], [p.x, p.y]] : undefined,
      name: tool === "textField" ? `field_${items.value.filter((i) => i.kind === "textField").length + 1}` : tool === "checkbox" ? `check_${items.value.filter((i) => i.kind === "checkbox").length + 1}` : undefined,
    };
    items.set((l) => [...l, it]);
    setSel(it.id);
    drag.current = { kind: "new", id: it.id, x0: p.x, y0: p.y };
  };

  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const p = frac(e);
    const box = { x: Math.min(d.x0, p.x), y: Math.min(d.y0, p.y), w: Math.abs(p.x - d.x0), h: Math.abs(p.y - d.y0) };
    if (tool === "crop" && d.kind === "new") {
      setCrops((m) => new Map(m).set(options.cropScope === "current" ? page : -1, box));
      return;
    }
    if (d.kind === "crop-move" || d.kind === "crop-resize") {
      const o = d.orig!;
      const dx = p.x - d.x0, dy = p.y - d.y0;
      const key = options.cropScope === "current" ? page : -1;
      const next = d.kind === "crop-move"
        ? { ...o, x: Math.min(1 - o.w, Math.max(0, o.x + dx)), y: Math.min(1 - o.h, Math.max(0, o.y + dy)) }
        : resizeRect(o, d.handle!, dx, dy);
      setCrops((m) => new Map(m).set(key, next));
      return;
    }
    if (tool === "redact" && d.kind === "new") {
      marks.set((l) => l.map((m) => (m.id === d.id ? { ...m, rect: box } : m)), false);
      return;
    }
    if (d.kind === "new" && d.id) {
      const it = items.value.find((i) => i.id === d.id);
      if (!it) return;
      if (it.kind === "path") patch(d.id, { points: [...(it.points ?? []), [p.x, p.y]] }, false);
      else if (it.kind === "line") patch(d.id, { points: [[d.x0, d.y0], [p.x, p.y]], ...box }, false);
      else patch(d.id, box, false);
      return;
    }
    if ((d.kind === "move" || d.kind === "resize") && d.id && d.orig) {
      const dx = p.x - d.x0, dy = p.y - d.y0;
      const it = items.value.find((i) => i.id === d.id);
      if (!it) return;
      if (d.kind === "move") {
        const nx = Math.min(1 - d.orig.w, Math.max(0, d.orig.x + dx));
        const ny = Math.min(1 - d.orig.h, Math.max(0, d.orig.y + dy));
        const shift = { x: nx - it.x, y: ny - it.y };
        patch(d.id, { x: nx, y: ny, points: it.points?.map(([a, b]) => [a + shift.x, b + shift.y] as [number, number]) }, false);
      } else {
        const r = resizeRect(d.orig, "se", dx, dy);
        // Images and signatures keep their aspect ratio.
        if (it.kind === "image") r.h = d.orig.h * (r.w / d.orig.w);
        patch(d.id, r, false);
      }
    }
  };

  const onUp = () => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (tool === "redact" && d.id) {
      marks.set((l) => l.filter((m) => m.rect.w > 0.004 && m.rect.h > 0.004), false);
      return;
    }
    if (d.kind === "new" && d.id) {
      const it = items.value.find((i) => i.id === d.id);
      if (!it) return;
      // A click without a drag drops a default-sized shape.
      if (it.kind !== "path" && it.kind !== "line" && (it.w < 0.01 || it.h < 0.006)) {
        const def = it.kind === "checkbox" ? { w: 0.03, h: 0.03 * ((size?.w ?? 1) / (size?.h ?? 1.414)) } : it.kind === "textField" ? { w: 0.3, h: 0.035 } : { w: 0.18, h: 0.08 };
        patch(it.id, def, false);
      }
      if ((it.kind === "path" || it.kind === "line") && it.points) {
        const xs = it.points.map((q) => q[0]), ys = it.points.map((q) => q[1]);
        patch(it.id, { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) }, false);
      }
    }
  };

  const startItemDrag = (e: React.PointerEvent, it: EditorItem, kind: "move" | "resize") => {
    if (tool !== "select" && tool !== "place") return;
    e.stopPropagation();
    if (editing === it.id && kind === "move") return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setSel(it.id);
    // Snapshot once per gesture so a whole drag undoes in one step.
    items.set((l) => [...l]);
    const p = frac(e);
    drag.current = { kind, id: it.id, x0: p.x, y0: p.y, orig: { x: it.x, y: it.y, w: it.w, h: it.h } };
  };

  // Keyboard: delete, undo/redo, nudge.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest("input, textarea, select, [contenteditable=true]")) return;
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) { items.redo(); marks.redo(); } else { items.undo(); marks.undo(); }
      } else if ((e.key === "Delete" || e.key === "Backspace") && sel) {
        e.preventDefault();
        items.set((l) => l.filter((i) => i.id !== sel));
        setSel(null);
      } else if (sel && e.key.startsWith("Arrow")) {
        e.preventDefault();
        const step = e.shiftKey ? 0.01 : 0.002;
        const it = items.value.find((i) => i.id === sel);
        if (!it) return;
        const dx = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
        const dy = e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0;
        patch(sel, { x: it.x + dx, y: it.y + dy, points: it.points?.map(([a, b]) => [a + dx, b + dy] as [number, number]) });
      } else if (e.key === "Escape") {
        setSel(null);
        setEditing(null);
        setStamp(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // ── Redaction search across all pages.
  // `preset` names one of the quick marks; otherwise `typed` is the search box text.
  const markMatches = async (typed: string, preset?: (typeof PRESET_NAMES)[number]) => {
    const [{ documentText }, { findMatches, searchPattern, PRESETS }] = await Promise.all([import("@/lib/pdf/text"), import("@/lib/pdf/security")]);
    const doc = await docFor(file);
    const pages = await documentText(doc);
    const pattern = preset ? PRESETS[preset] : searchPattern(typed, { matchCase, wholeWord });
    const hits = findMatches(pages, pattern);
    const search = uid();
    const of = new Map<string, number>();
    for (const h of hits) of.set(h.text, (of.get(h.text) ?? 0) + 1);
    marks.set((l) => [...l, ...hits.map((h) => ({ id: uid(), page: h.page, rect: h.rect, term: h.text, search, pattern, of: of.get(h.text) }))]);
    // A match that wraps to the next line has a box on each line but counts once.
    setFound(new Set(hits.map((h) => h.hit)).size);
  };

  // ── Crop: trim to the inked area of the current page.
  const autoCrop = async () => {
    const doc = await docFor(file);
    const pg = await doc.getPage(page + 1);
    const v = pg.getViewport({ scale: 600 / pg.getViewport({ scale: 1 }).width });
    const c = document.createElement("canvas");
    c.width = Math.ceil(v.width);
    c.height = Math.ceil(v.height);
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, c.width, c.height);
    await pg.render({ canvas: c, canvasContext: ctx, viewport: v, intent: "print" }).promise;
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    let x0 = c.width, y0 = c.height, x1 = 0, y1 = 0;
    for (let y = 0; y < c.height; y++)
      for (let x = 0; x < c.width; x++) {
        const i = (y * c.width + x) * 4;
        if (d[i] + d[i + 1] + d[i + 2] < 720) {
          if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
        }
      }
    if (x1 <= x0) return;
    const m = 0.015;
    const r = { x: Math.max(0, x0 / c.width - m), y: Math.max(0, y0 / c.height - m), w: 0, h: 0 };
    r.w = Math.min(1 - r.x, (x1 - x0) / c.width + m * 2);
    r.h = Math.min(1 - r.y, (y1 - y0) / c.height + m * 2);
    setCrops((mp) => new Map(mp).set(options.cropScope === "current" ? page : -1, r));
  };

  const run = () => {
    onRun(async (progress) => {
      const edit = await import("@/lib/pdf/edit");
      if (toolId === "redact") {
        const { redact } = await import("@/lib/pdf/security");
        // A searched text whose every hit is still marked must be gone from the whole file; redact() checks.
        const kept = new Map<string, { text: string; pattern?: RegExp; of: number; n: number }>();
        for (const m of marks.value) {
          if (!m.term || !m.search) continue;
          const k = `${m.search}\n${m.term}`;
          const e = kept.get(k) ?? { text: m.term, pattern: m.pattern, of: m.of ?? 0, n: 0 };
          e.n++;
          kept.set(k, e);
        }
        const terms = [...kept.values()].filter((e) => e.n >= e.of).map(({ text, pattern }) => ({ text, pattern }));
        return redact(file, marks.value.map((m) => ({ page: m.page, rect: m.rect })), { redactDpi: String(options.redactDpi ?? "200"), terms }, progress);
      }
      if (toolId === "crop") {
        const all = crops.get(-1);
        if (options.cropScope !== "current" && all) return edit.crop(file, all);
        return edit.crop(file, new Map([...crops].filter(([k]) => k >= 0)));
      }
      if (toolId === "forms") return edit.fillForm(file, values, items.value, Boolean(options.flatten));
      return edit.editPdf(file, items.value, toolId === "sign" ? "signed" : "edited");
    });
  };

  const canRun =
    toolId === "redact" ? marks.value.length > 0 :
    toolId === "crop" ? [...crops.values()].some((r) => r.w > 0.02 && r.h > 0.02) :
    toolId === "forms" ? true : items.value.length > 0;

  const tools: { id: EdTool; icon: React.ReactNode; label: string }[] = useMemo(() => {
    const base = [{ id: "select" as EdTool, icon: <MousePointer2 size={18} />, label: t("ed.select") }];
    if (toolId === "edit") return [...base,
      { id: "text", icon: <Type size={18} />, label: t("ed.text") },
      { id: "image", icon: <ImagePlus size={18} />, label: t("ed.image") },
      { id: "rect", icon: <Square size={18} />, label: t("ed.rect") },
      { id: "ellipse", icon: <Circle size={18} />, label: t("ed.ellipse") },
      { id: "line", icon: <Minus size={18} />, label: t("ed.line") },
      { id: "path", icon: <Pencil size={18} />, label: t("ed.draw") },
      { id: "highlight", icon: <Highlighter size={18} />, label: t("ed.highlight") },
      { id: "whiteout", icon: <Eraser size={18} />, label: t("ed.whiteout") },
    ];
    if (toolId === "sign") return [...base, { id: "text", icon: <Type size={18} />, label: t("ed.text") }];
    if (toolId === "forms") return [...base,
      { id: "textField", icon: <TextCursorInput size={18} />, label: t("ed.addTextField") },
      { id: "checkbox", icon: <SquareCheck size={18} />, label: t("ed.addCheckbox") },
      { id: "text", icon: <Type size={18} />, label: t("ed.text") },
    ];
    if (toolId === "redact") return [{ id: "redact", icon: <ScanEye size={18} />, label: t("ed.redactArea") }];
    return [{ id: "crop", icon: <CropIcon size={18} />, label: t("tool.crop.name") }];
  }, [toolId, t]);

  const cursor = tool === "select" ? "default" : tool === "text" ? "text" : "crosshair";

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
      <div className="min-w-0">
        {/* Toolbar */}
        <div className="sticky top-[72px] z-20 mb-3 flex flex-wrap items-center gap-1 rounded-xl border border-line bg-[color-mix(in_oklab,var(--surface)_92%,transparent)] p-1.5 shadow-card backdrop-blur-md">
          {tools.map((x) => (
            <button key={x.id} className="icon-btn" aria-pressed={tool === x.id} aria-label={x.label} title={x.label}
              onClick={() => {
                setTool(x.id);
                if (x.id === "image") imageInput.current?.click();
              }}>
              {x.icon}
            </button>
          ))}
          <input ref={imageInput} type="file" accept="image/*" hidden onChange={async (e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (!f) return;
            const url = await new Promise<string>((r) => { const fr = new FileReader(); fr.onload = () => r(String(fr.result)); fr.readAsDataURL(f); });
            const bmp = await createImageBitmap(f);
            setPendingImage({ url, ratio: bmp.height / bmp.width });
            setTool("image");
          }} />
          <span className="mx-1 h-6 w-px bg-line" />
          <button className="icon-btn" aria-label={t("ed.undo")} title={t("ed.undo")} disabled={!items.canUndo && !marks.canUndo} onClick={() => { items.undo(); marks.undo(); }}><Undo2 size={18} /></button>
          <button className="icon-btn" aria-label={t("ed.redo")} title={t("ed.redo")} disabled={!items.canRedo && !marks.canRedo} onClick={() => { items.redo(); marks.redo(); }}><Redo2 size={18} /></button>
          <span className="ms-auto flex items-center gap-1">
            <button className="icon-btn" aria-label={t("ed.zoomOut")} onClick={() => setZoom((z) => Math.max(0.5, +(z - 0.25).toFixed(2)))}><ZoomOut size={18} /></button>
            <span className="tabular w-11 text-center text-[13px] text-muted">{Math.round(zoom * 100)}%</span>
            <button className="icon-btn" aria-label={t("ed.zoomIn")} onClick={() => setZoom((z) => Math.min(3, +(z + 0.25).toFixed(2)))}><ZoomIn size={18} /></button>
          </span>
        </div>

        {/* Page */}
        <div ref={wrap} className="overflow-auto rounded-xl bg-surface-2 p-4">
          <div
            ref={stage}
            className="relative mx-auto touch-none select-none bg-white shadow-[0_0_0_1px_var(--line),0_8px_24px_rgb(0_0_0/0.08)]"
            style={{ width, height, cursor }}
            onPointerDown={onDown}
            onPointerMove={onMove}
            onPointerUp={onUp}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            {img && <img src={img} alt="" draggable={false} className="absolute inset-0 h-full w-full" />}

            {/* Existing form fields */}
            {toolId === "forms" && fields.filter((f) => f.page === page && f.rect).map((f) => (
              <label key={f.name} className="absolute rounded-sm bg-[color-mix(in_oklab,var(--accent)_14%,transparent)] outline outline-1 outline-[var(--accent)]"
                style={{ left: `${f.rect!.x * 100}%`, top: `${f.rect!.y * 100}%`, width: `${f.rect!.w * 100}%`, height: `${f.rect!.h * 100}%` }}
                onPointerDown={(e) => e.stopPropagation()}>
                {f.type === "checkbox" ? (
                  <input type="checkbox" className="h-full w-full accent-[var(--accent)]" checked={Boolean(values[f.name])} onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.checked }))} />
                ) : f.type === "text" ? (
                  <input className="h-full w-full bg-transparent px-1 text-black outline-none" style={{ fontSize: Math.max(9, f.rect!.h * height * 0.62) }}
                    value={String(values[f.name] ?? "")} onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.value }))} aria-label={f.name} />
                ) : null}
              </label>
            ))}

            {/* Redaction marks */}
            {pageMarks.map((m) => (
              <div key={m.id} className="group absolute bg-black/80 outline outline-2 outline-[var(--danger)]"
                style={{ left: `${m.rect.x * 100}%`, top: `${m.rect.y * 100}%`, width: `${m.rect.w * 100}%`, height: `${m.rect.h * 100}%` }}>
                <button className="absolute -right-2.5 -top-2.5 hidden h-5 w-5 place-items-center rounded-full bg-danger text-white group-hover:grid"
                  aria-label={t("ws.remove")} onPointerDown={(e) => e.stopPropagation()} onClick={() => marks.set((l) => l.filter((x) => x.id !== m.id))}>
                  <Trash2 size={11} />
                </button>
              </div>
            ))}

            {/* Crop */}
            {toolId === "crop" && cropRect && cropRect.w > 0 && (
              <CropOverlay rect={cropRect} onStart={(e, handle) => {
                e.stopPropagation();
                (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
                const p = frac(e);
                drag.current = { kind: handle ? "crop-resize" : "crop-move", x0: p.x, y0: p.y, orig: cropRect, handle };
              }} />
            )}

            {/* Items */}
            <svg className="pointer-events-none absolute inset-0 h-full w-full" viewBox="0 0 1000 1000" preserveAspectRatio="none">
              {pageItems.filter((i) => i.kind === "path" || i.kind === "line").map((i) => (
                <polyline key={i.id} points={(i.points ?? []).map(([x, y]) => `${x * 1000},${y * 1000}`).join(" ")} fill="none" stroke={i.color}
                  strokeWidth={(i.stroke ?? 2) * ptToPx} vectorEffect="non-scaling-stroke" strokeLinecap="round" strokeLinejoin="round" />
              ))}
            </svg>
            {pageItems.map((i) => {
              const boxStyle: React.CSSProperties = { left: `${i.x * 100}%`, top: `${i.y * 100}%`, width: `${i.w * 100}%`, height: `${i.h * 100}%` };
              const isSel = sel === i.id;
              const frame = isSel ? "outline outline-2 outline-offset-2 outline-[var(--accent)]" : "";
              const common = { onPointerDown: (e: React.PointerEvent) => startItemDrag(e, i, "move"), onPointerMove: onMove, onPointerUp: onUp };
              let inner: React.ReactNode = null;
              if (i.kind === "text") {
                const fs = (i.fontSize ?? 16) * ptToPx;
                return (
                  <div key={i.id} {...common} onDoubleClick={() => setEditing(i.id)}
                    className={`absolute whitespace-pre ${frame} ${editing === i.id ? "" : "cursor-move"}`}
                    style={{ left: `${i.x * 100}%`, top: `${i.y * 100}%`, fontSize: fs, lineHeight: 1.25, color: i.color, fontWeight: i.bold ? 700 : 400, fontFamily: "Helvetica, Arial, sans-serif", minWidth: 8, minHeight: fs * 1.25 }}>
                    {editing === i.id ? (
                      <textarea ref={(el) => { if (el && document.activeElement !== el) requestAnimationFrame(() => el.focus()); }} value={i.text ?? ""} rows={Math.max(1, (i.text ?? "").split("\n").length)}
                        onPointerDown={(e) => e.stopPropagation()}
                        onChange={(e) => patch(i.id, { text: e.target.value }, false)}
                        onBlur={() => { setEditing(null); if (!(i.text ?? "").trim()) items.set((l) => l.filter((x) => x.id !== i.id), false); }}
                        placeholder={t("ed.typeHere")}
                        className="resize-none overflow-hidden bg-[color-mix(in_oklab,var(--accent)_6%,transparent)] outline-none"
                        style={{ font: "inherit", color: "inherit", width: `${Math.max(6, ...((i.text || t("ed.typeHere")).split("\n").map((l) => l.length + 1)))}ch` }} />
                    ) : (i.text || " ")}
                  </div>
                );
              }
              if (i.kind === "path" || i.kind === "line") {
                return <div key={i.id} {...common} className={`absolute cursor-move ${frame}`} style={{ ...boxStyle, minWidth: 6, minHeight: 6 }} />;
              }
              if (i.kind === "image") {
                // eslint-disable-next-line @next/next/no-img-element
                inner = <img src={i.image} alt="" draggable={false} className="h-full w-full" />;
              }
              const shape: React.CSSProperties =
                i.kind === "rect" ? { border: `${(i.stroke ?? 2) * ptToPx}px solid ${i.color}`, background: i.fill ?? "transparent" } :
                i.kind === "ellipse" ? { border: `${(i.stroke ?? 2) * ptToPx}px solid ${i.color}`, background: i.fill ?? "transparent", borderRadius: "50%" } :
                i.kind === "highlight" ? { background: i.color, opacity: 0.38, mixBlendMode: "multiply" } :
                i.kind === "whiteout" ? { background: "#fff", boxShadow: isSel ? undefined : "0 0 0 1px rgb(0 0 0 / 0.06)" } :
                i.kind === "textField" ? { background: "color-mix(in oklab, var(--accent) 12%, transparent)", border: "1px dashed var(--accent)" } :
                i.kind === "checkbox" ? { border: "1.5px solid #4b5563", background: "#fff" } : {};
              return (
                <div key={i.id} {...common} className={`absolute cursor-move ${frame}`} style={{ ...boxStyle, ...shape }}>
                  {inner}
                  {i.kind === "textField" && <span className="absolute left-1 top-0 text-[10px] text-accent">{i.name}</span>}
                  {isSel && (
                    <span onPointerDown={(e) => startItemDrag(e, i, "resize")}
                      className="absolute -bottom-2 -right-2 h-4 w-4 cursor-nwse-resize rounded-full border-2 border-white bg-accent shadow" />
                  )}
                </div>
              );
            })}
            {(tool === "place" && stamp) || (tool === "image" && pendingImage) ? (
              <div className="pointer-events-none absolute inset-x-0 top-3 mx-auto w-max rounded-lg bg-ink px-3 py-1.5 text-[13px] text-bg shadow-card">{t("ed.clickToPlace")}</div>
            ) : null}
          </div>
        </div>

        {/* Page navigation */}
        {sizes.length > 1 && (
          <div className="mt-3 flex items-center justify-center gap-2">
            <button className="icon-btn" aria-label={t("ed.prevPage")} disabled={page === 0} onClick={() => setPage((p) => p - 1)}><ChevronLeft size={18} /></button>
            <span className="tabular text-[14px] text-muted">{page + 1} / {sizes.length}</span>
            <button className="icon-btn" aria-label={t("ed.nextPage")} disabled={page >= sizes.length - 1} onClick={() => setPage((p) => p + 1)}><ChevronRight size={18} /></button>
          </div>
        )}
      </div>

      {/* Side panel */}
      <aside className="card h-max space-y-5 p-5 lg:sticky lg:top-20">
        {toolId === "sign" && (
          <div className="grid gap-2">
            <button className="btn btn-quiet justify-start" onClick={() => setPad("signature")}><SignatureIcon size={18} /> {t("ed.signature")}</button>
            <button className="btn btn-quiet justify-start" onClick={() => setPad("initials")}><Type size={18} /> {t("ed.initials")}</button>
            <button className="btn btn-quiet justify-start" onClick={() => { setStamp({ text: new Date().toLocaleDateString() }); setTool("place"); }}>
              <CalendarDays size={18} /> {t("ed.date")}
            </button>
          </div>
        )}

        {toolId === "redact" && (
          <div className="space-y-3">
            <form className="flex gap-2" onSubmit={(e) => {
              e.preventDefault();
              if (!query.trim()) return;
              void markMatches(query);
            }}>
              <input className="field" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("ed.redactSearchPlaceholder")} aria-label={t("ed.redactSearch")} />
              <button className="icon-btn h-10 w-10 shrink-0 border border-line" aria-label={t("ed.redactSearch")}><Search size={17} /></button>
            </form>
            <div className="flex flex-wrap gap-x-4 gap-y-1.5">
              <label className="flex items-center gap-2 text-[13px] text-ink-2">
                <input type="checkbox" className="accent-[var(--accent)]" checked={matchCase} onChange={(e) => setMatchCase(e.target.checked)} />
                {t("ed.redactMatchCase")}
              </label>
              <label className="flex items-center gap-2 text-[13px] text-ink-2">
                <input type="checkbox" className="accent-[var(--accent)]" checked={wholeWord} onChange={(e) => setWholeWord(e.target.checked)} />
                {t("ed.redactWholeWords")}
              </label>
            </div>
            <div>
              <p className="mb-1.5 text-[13px] font-medium text-ink-2">{t("ed.redactPresets")}</p>
              <div className="flex flex-wrap gap-1.5">
                {PRESET_NAMES.map((k) => (
                  <button key={k} className="btn btn-quiet btn-sm" onClick={() => markMatches("", k)}>
                    {t(`ed.redact${k[0].toUpperCase()}${k.slice(1)}`)}
                  </button>
                ))}
              </div>
            </div>
            {found !== null && <p className="text-[14px] text-muted">{t("ed.redactFound", { n: found })}</p>}
            <p className="rounded-xl bg-surface-2 p-3 text-[13px] text-ink-2">{t("ed.redactNote")}</p>
          </div>
        )}

        {toolId === "crop" && (
          <div className="space-y-3">
            <p className="text-[14px] text-muted">{t("ed.cropHint")}</p>
            <div className="flex gap-2">
              <button className="btn btn-quiet btn-sm" onClick={autoCrop}><CropIcon size={16} /> {t("ed.cropAuto")}</button>
              <button className="btn btn-quiet btn-sm" onClick={() => setCrops(new Map())}>{t("ed.cropReset")}</button>
            </div>
          </div>
        )}

        {toolId === "forms" && (
          <div>
            <p className="mb-2 text-[13px] font-medium text-ink-2">{t("ed.formFields")}</p>
            {fields.length === 0 ? <p className="text-[14px] text-muted">{t("ed.noFields")}</p> : (
              <div className="max-h-[340px] space-y-3 overflow-auto pr-1">
                {fields.map((f) => (
                  <label key={f.name} className="block">
                    <span className="mb-1 block truncate text-[13px] text-muted" title={f.name}>{f.name}</span>
                    {f.type === "checkbox" ? (
                      <input type="checkbox" className="h-5 w-5 accent-[var(--accent)]" checked={Boolean(values[f.name])} onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.checked }))} />
                    ) : f.type === "dropdown" || f.type === "radio" ? (
                      <select className="field" value={String(values[f.name] ?? "")} onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.value }))}>
                        <option value="" />
                        {f.options?.map((o) => <option key={o}>{o}</option>)}
                      </select>
                    ) : f.type === "list" ? (
                      <select multiple className="field h-24" value={(values[f.name] as string[]) ?? []} onChange={(e) => setValues((v) => ({ ...v, [f.name]: Array.from(e.target.selectedOptions, (o) => o.value) }))}>
                        {f.options?.map((o) => <option key={o}>{o}</option>)}
                      </select>
                    ) : f.multiline ? (
                      <textarea className="field" rows={3} value={String(values[f.name] ?? "")} onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.value }))} />
                    ) : (
                      <input className="field" value={String(values[f.name] ?? "")} onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.value }))} />
                    )}
                  </label>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Style for new and selected items */}
        {(toolId === "edit" || toolId === "sign" || toolId === "forms") && (selected?.kind !== "image") && (
          <div className="space-y-3">
            <div className="flex flex-wrap gap-1.5">
              {COLORS.map((c) => (
                <button key={c} aria-label={c} aria-pressed={(selected?.color ?? style.color) === c}
                  onClick={() => { setStyle((s) => ({ ...s, color: c })); if (selected) patch(selected.id, { color: c }); }}
                  className="h-7 w-7 rounded-full border border-line ring-offset-2 ring-offset-[var(--surface)] aria-pressed:ring-2 aria-pressed:ring-[var(--ink)]" style={{ background: c }} />
              ))}
            </div>
            {(!selected || selected.kind === "text") && (
              <div className="flex items-center gap-2">
                <label className="flex flex-1 items-center gap-2 text-[13px] text-ink-2">
                  {t("ed.fontSize")}
                  <input type="number" min={6} max={96} className="field h-9 w-20" value={selected?.fontSize ?? style.fontSize}
                    onChange={(e) => { const v = Math.max(6, Math.min(96, Number(e.target.value) || 12)); setStyle((s) => ({ ...s, fontSize: v })); if (selected) patch(selected.id, { fontSize: v }); }} />
                </label>
                <button className="icon-btn border border-line" aria-pressed={selected?.bold ?? style.bold} aria-label="Bold"
                  onClick={() => { const b = !(selected?.bold ?? style.bold); setStyle((s) => ({ ...s, bold: b })); if (selected) patch(selected.id, { bold: b }); }}>
                  <Bold size={16} />
                </button>
              </div>
            )}
            {(!selected || ["rect", "ellipse", "line", "path"].includes(selected.kind)) && toolId === "edit" && (
              <label className="flex items-center gap-2 text-[13px] text-ink-2">
                {t("ed.stroke")}
                <input type="range" min={0.5} max={12} step={0.5} className="flex-1 accent-[var(--accent)]" value={selected?.stroke ?? style.stroke}
                  onChange={(e) => { const v = Number(e.target.value); setStyle((s) => ({ ...s, stroke: v })); if (selected) patch(selected.id, { stroke: v }, false); }} />
              </label>
            )}
            {(!selected || ["rect", "ellipse"].includes(selected.kind)) && toolId === "edit" && (
              <label className="flex items-center gap-2 text-[13px] text-ink-2">
                <input type="checkbox" className="accent-[var(--accent)]" checked={Boolean(selected?.fill ?? style.fill)}
                  onChange={(e) => { const f = e.target.checked ? (selected?.color ?? style.color) : null; setStyle((s) => ({ ...s, fill: f })); if (selected) patch(selected.id, { fill: f }); }} />
                {t("ed.fill")}
              </label>
            )}
          </div>
        )}

        {selected && (
          <div className="flex flex-wrap gap-2 border-t border-line pt-4">
            {toolId === "sign" && sizes.length > 1 && (
              <button className="btn btn-quiet btn-sm" onClick={() => items.set((l) => [...l, ...sizes.map((_, p) => p).filter((p) => p !== selected.page).map((p) => ({ ...selected, id: uid(), page: p }))])}>
                <Copy size={15} /> {t("ed.applyAll")}
              </button>
            )}
            <button className="btn btn-quiet btn-sm text-danger" onClick={() => { items.set((l) => l.filter((i) => i.id !== selected.id)); setSel(null); }}>
              <Trash2 size={15} /> {t("ed.deleteItem")}
            </button>
          </div>
        )}

        <button className="btn btn-primary btn-lg w-full" disabled={!canRun} onClick={run}>{actionLabel}</button>
      </aside>

      {pad && (
        <SignaturePad kind={pad} onClose={() => setPad(null)} onDone={(s) => { setPad(null); setStamp({ image: s }); setTool("place"); }} />
      )}
    </div>
  );
}

function resizeRect(o: FracRect, handle: string, dx: number, dy: number): FracRect {
  let { x, y, w, h } = o;
  if (handle.includes("e")) w = Math.max(0.02, Math.min(1 - x, w + dx));
  if (handle.includes("s")) h = Math.max(0.02, Math.min(1 - y, h + dy));
  if (handle.includes("w")) { const nx = Math.max(0, Math.min(x + w - 0.02, x + dx)); w += x - nx; x = nx; }
  if (handle.includes("n")) { const ny = Math.max(0, Math.min(y + h - 0.02, y + dy)); h += y - ny; y = ny; }
  return { x, y, w, h };
}

function CropOverlay({ rect, onStart }: { rect: FracRect; onStart: (e: React.PointerEvent, handle?: string) => void }) {
  const pct = (v: number) => `${v * 100}%`;
  return (
    <>
      <div className="pointer-events-none absolute inset-0 bg-black/45" style={{
        clipPath: `polygon(0 0, 100% 0, 100% 100%, 0 100%, 0 0, ${pct(rect.x)} ${pct(rect.y)}, ${pct(rect.x)} ${pct(rect.y + rect.h)}, ${pct(rect.x + rect.w)} ${pct(rect.y + rect.h)}, ${pct(rect.x + rect.w)} ${pct(rect.y)}, ${pct(rect.x)} ${pct(rect.y)})`,
      }} />
      <div className="absolute cursor-move outline outline-2 outline-white" style={{ left: pct(rect.x), top: pct(rect.y), width: pct(rect.w), height: pct(rect.h) }}
        onPointerDown={(e) => onStart(e)}>
        {["nw", "ne", "sw", "se", "n", "s", "e", "w"].map((h) => (
          <span key={h} onPointerDown={(e) => onStart(e, h)}
            className="absolute h-3.5 w-3.5 rounded-full border-2 border-white bg-accent"
            style={{
              left: h.includes("w") ? -7 : h.includes("e") ? "calc(100% - 7px)" : "calc(50% - 7px)",
              top: h.includes("n") ? -7 : h.includes("s") ? "calc(100% - 7px)" : "calc(50% - 7px)",
              cursor: `${h}-resize`,
            }} />
        ))}
      </div>
    </>
  );
}
