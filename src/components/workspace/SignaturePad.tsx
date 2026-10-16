"use client";

import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { useI18n } from "../I18n";

const INKS = ["#111827", "#1d4ed8", "#b91c1c"];
const SCRIPTS = [
  '"Snell Roundhand", "Segoe Script", "Brush Script MT", cursive',
  '"Bradley Hand", "Segoe Print", "Comic Sans MS", cursive',
  '"Zapfino", "Lucida Handwriting", "Apple Chancery", cursive',
];

// Crops a canvas to its inked area and returns a transparent PNG data URL.
function trimmed(canvas: HTMLCanvasElement) {
  const ctx = canvas.getContext("2d")!;
  const { width, height } = canvas;
  const data = ctx.getImageData(0, 0, width, height).data;
  let x0 = width, y0 = height, x1 = 0, y1 = 0;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      if (data[(y * width + x) * 4 + 3] > 8) {
        if (x < x0) x0 = x;
        if (y < y0) y0 = y;
        if (x > x1) x1 = x;
        if (y > y1) y1 = y;
      }
  if (x1 <= x0 || y1 <= y0) return null;
  const pad = 6;
  const out = document.createElement("canvas");
  out.width = x1 - x0 + pad * 2;
  out.height = y1 - y0 + pad * 2;
  out.getContext("2d")!.drawImage(canvas, x0 - pad, y0 - pad, out.width, out.height, 0, 0, out.width, out.height);
  return { url: out.toDataURL("image/png"), ratio: out.height / out.width };
}

export type SignatureImage = { url: string; ratio: number };

export function SignaturePad({ kind, onDone, onClose }: { kind: "signature" | "initials"; onDone: (s: SignatureImage) => void; onClose: () => void }) {
  const { t } = useI18n();
  const [tab, setTab] = useState<"draw" | "type" | "upload">("draw");
  const [ink, setInk] = useState(INKS[0]);
  const [name, setName] = useState("");
  const [script, setScript] = useState(0);
  const [upload, setUpload] = useState<SignatureImage | null>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const drawing = useRef<{ x: number; y: number } | null>(null);
  const [hasInk, setHasInk] = useState(false);
  const storeKey = `saved-${kind}`;
  // Only rendered after a click, so browser storage is available here.
  const [saved] = useState<SignatureImage[]>(() => {
    try {
      return JSON.parse(localStorage.getItem(storeKey) ?? "[]");
    } catch {
      return [];
    }
  });

  useEffect(() => {
    const c = canvas.current;
    if (!c || tab !== "draw") return;
    const dpr = window.devicePixelRatio || 1;
    c.width = c.clientWidth * dpr;
    c.height = c.clientHeight * dpr;
    const ctx = c.getContext("2d")!;
    ctx.scale(dpr, dpr);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
  }, [tab]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const point = (e: React.PointerEvent) => {
    const r = canvas.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top, p: e.pressure || 0.5 };
  };

  const typed = () => {
    const c = document.createElement("canvas");
    c.width = 1400;
    c.height = 360;
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = ink;
    ctx.font = `${kind === "initials" ? 200 : 150}px ${SCRIPTS[script]}`;
    ctx.textBaseline = "middle";
    ctx.fillText(name, 40, 180);
    return trimmed(c);
  };

  const finish = () => {
    let sig: SignatureImage | null = null;
    if (tab === "draw" && canvas.current) sig = trimmed(canvas.current);
    else if (tab === "type" && name.trim()) sig = typed();
    else if (tab === "upload") sig = upload;
    if (!sig) return;
    try {
      const next = [sig, ...saved.filter((s) => s.url !== sig!.url)].slice(0, 4);
      localStorage.setItem(storeKey, JSON.stringify(next));
    } catch {
      /* storage full or blocked: still usable this time */
    }
    onDone(sig);
  };

  const onUpload = async (file: File) => {
    const bmp = await createImageBitmap(file);
    const c = document.createElement("canvas");
    const s = Math.min(1, 1400 / bmp.width);
    c.width = bmp.width * s;
    c.height = bmp.height * s;
    const ctx = c.getContext("2d")!;
    ctx.drawImage(bmp, 0, 0, c.width, c.height);
    // Paper-white becomes transparent so the signature sits on the page cleanly.
    const img = ctx.getImageData(0, 0, c.width, c.height);
    for (let i = 0; i < img.data.length; i += 4) {
      const lum = 0.299 * img.data[i] + 0.587 * img.data[i + 1] + 0.114 * img.data[i + 2];
      img.data[i + 3] = lum > 215 ? 0 : lum > 170 ? Math.round(((215 - lum) / 45) * 255) : 255;
    }
    ctx.putImageData(img, 0, 0);
    setUpload(trimmed(c));
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-[rgb(10_14_22/0.45)] p-4" role="dialog" aria-modal onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="rise card w-full max-w-[560px] p-5 shadow-card">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold">{t("ed.createSignature")}</h2>
          <button className="icon-btn" aria-label={t("nav.close")} onClick={onClose}><X size={18} /></button>
        </div>
        {saved.length > 0 && (
          <div className="mb-4 flex gap-2 overflow-x-auto">
            {saved.map((s) => (
              <button key={s.url} className="h-14 shrink-0 rounded-lg border border-line bg-white px-3 hover:border-brand" onClick={() => onDone(s)}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={s.url} alt="" className="h-10 w-auto" />
              </button>
            ))}
          </div>
        )}
        <div className="mb-3 flex gap-1 rounded-full bg-surface-2 p-1" role="tablist">
          {(["draw", "type", "upload"] as const).map((k) => (
            <button key={k} role="tab" aria-selected={tab === k} onClick={() => { setTab(k); setHasInk(false); }}
              className={`flex-1 rounded-full py-1.5 text-[14px] font-medium ${tab === k ? "bg-surface shadow-sm" : "text-muted"}`}>
              {t(`ed.${k}Tab`)}
            </button>
          ))}
        </div>
        {tab === "draw" && (
          <canvas
            ref={canvas}
            className="h-[200px] w-full touch-none rounded-xl border border-line bg-white"
            onPointerDown={(e) => {
              (e.target as HTMLElement).setPointerCapture(e.pointerId);
              drawing.current = point(e);
            }}
            onPointerMove={(e) => {
              if (!drawing.current) return;
              const p = point(e);
              const ctx = canvas.current!.getContext("2d")!;
              ctx.strokeStyle = ink;
              ctx.lineWidth = 1.6 + p.p * 2.4;
              ctx.beginPath();
              ctx.moveTo(drawing.current.x, drawing.current.y);
              ctx.lineTo(p.x, p.y);
              ctx.stroke();
              drawing.current = p;
              setHasInk(true);
            }}
            onPointerUp={() => (drawing.current = null)}
          />
        )}
        {tab === "type" && (
          <div className="space-y-3">
            <input className="field" placeholder={t("ed.typeName")} value={name} onChange={(e) => setName(e.target.value)} autoFocus />
            <div className="grid gap-2">
              {SCRIPTS.map((f, i) => (
                <button key={f} onClick={() => setScript(i)}
                  className={`h-16 truncate rounded-xl border bg-white px-4 text-start text-[34px] ${script === i ? "border-brand" : "border-line"}`}
                  style={{ fontFamily: f, color: ink }}>
                  {name || t("ed.typeName")}
                </button>
              ))}
            </div>
          </div>
        )}
        {tab === "upload" && (
          <label className="grid h-[200px] cursor-pointer place-items-center rounded-xl border-2 border-dashed border-line-strong bg-white text-muted">
            <input type="file" accept="image/*" hidden onChange={(e) => e.target.files?.[0] && onUpload(e.target.files[0])} />
            {upload ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={upload.url} alt="" className="max-h-[160px] max-w-[90%]" />
            ) : (
              <span>{t("ed.uploadTab")}</span>
            )}
          </label>
        )}
        <div className="mt-4 flex items-center gap-2">
          {tab !== "upload" && INKS.map((c) => (
            <button key={c} aria-label={c} aria-pressed={ink === c} onClick={() => setInk(c)}
              className="h-7 w-7 rounded-full ring-offset-2 ring-offset-[var(--surface)] aria-pressed:ring-2 aria-pressed:ring-[var(--ink)]" style={{ background: c }} />
          ))}
          {tab === "draw" && (
            <button className="btn btn-quiet btn-sm ms-2" onClick={() => {
              const c = canvas.current!;
              c.getContext("2d")!.clearRect(0, 0, c.width, c.height);
              setHasInk(false);
            }}>{t("ed.clear")}</button>
          )}
          <button className="btn btn-primary ms-auto" onClick={finish}
            disabled={(tab === "draw" && !hasInk) || (tab === "type" && !name.trim()) || (tab === "upload" && !upload)}>
            {t("ed.useSignature")}
          </button>
        </div>
      </div>
    </div>
  );
}
