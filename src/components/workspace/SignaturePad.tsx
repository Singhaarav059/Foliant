"use client";

import { colorKey } from "@/lib/colors";
import { useEffect, useId, useRef, useState } from "react";
import { X } from "lucide-react";
import { useI18n } from "../I18n";
import { VENDOR } from "@/lib/vendor";

const INKS = ["#111827", "#1d4ed8", "#b91c1c"];
// Handwriting fonts served from /vendor (scripts/vendor.mjs), so a typed
// signature looks the same on every system. OFL-1.1, from Fontsource.
const SCRIPTS = [
  { family: "Dancing Script", file: "dancing-script" },
  { family: "Great Vibes", file: "great-vibes" },
  { family: "Caveat", file: "caveat" },
];
const stack = (family: string) => `"${family}", cursive`;
// Fontsource's Latin and Latin Extended slices, the same for all three.
const SUBSETS: [string, string][] = [
  ["latin", "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD"],
  ["latin-ext", "U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF"],
];
let scriptFonts: Promise<unknown> | null = null;
// Registers the faces once and starts loading the Latin ones; Latin
// Extended loads when a name needs it.
function loadScriptFonts() {
  if (!scriptFonts) {
    const faces = SCRIPTS.flatMap(({ family, file }) => SUBSETS.map(([subset, unicodeRange]) =>
      new FontFace(family, `url(${VENDOR}signature-fonts/${file}-${subset}-400-normal.woff2) format("woff2")`, { unicodeRange, display: "swap" })));
    faces.forEach((f) => document.fonts.add(f));
    scriptFonts = Promise.allSettled(faces.filter((_, i) => i % SUBSETS.length === 0).map((f) => f.load()));
  }
  return scriptFonts;
}

// Crops a canvas to its inked area and returns a transparent PNG data URL.
function trimmed(canvas: HTMLCanvasElement) {
  const ctx = canvas.getContext("2d")!;
  const { width, height } = canvas;
  if (!width || !height) return null;
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

// A modal <dialog>: focus stays inside, Escape closes it. A stamp is an
// uploaded image only.
export function SignaturePad({ kind, onDone, onClose }: { kind: "signature" | "initials" | "stamp"; onDone: (s: SignatureImage) => void; onClose: () => void }) {
  const { t } = useI18n();
  const tabs = kind === "stamp" ? (["upload"] as const) : (["draw", "type", "upload"] as const);
  const [tab, setTab] = useState<"draw" | "type" | "upload">(tabs[0]);
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
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

  // Opened before the canvas is sized below: effects run in order, and a
  // closed <dialog> lays nothing out, so the canvas would measure 0 wide.
  useEffect(() => {
    const d = dialog.current;
    if (d && !d.open) d.showModal();
    return () => d?.close();
  }, []);

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
    if (kind !== "stamp") void loadScriptFonts();
  }, [kind]);

  const point = (e: React.PointerEvent) => {
    const r = canvas.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top, p: e.pressure || 0.5 };
  };

  const typed = async () => {
    const font = `${kind === "initials" ? 200 : 150}px ${stack(SCRIPTS[script].family)}`;
    // Canvas text doesn't wait for a font, so load it (and any slice this name needs) first.
    await loadScriptFonts();
    await document.fonts.load(font, name).catch(() => {});
    const c = document.createElement("canvas");
    c.width = 1400;
    c.height = 360;
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = ink;
    ctx.font = font;
    ctx.textBaseline = "middle";
    ctx.fillText(name, 40, 180);
    return trimmed(c);
  };

  const finish = async () => {
    let sig: SignatureImage | null = null;
    if (tab === "draw" && canvas.current) sig = trimmed(canvas.current);
    else if (tab === "type" && name.trim()) sig = await typed();
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
    <dialog ref={dialog} aria-labelledby={titleId}
      className="rise card m-auto w-[calc(100%-2rem)] max-w-[560px] p-5 text-ink shadow-card backdrop:bg-[rgb(10_14_22/0.45)]"
      onCancel={(e) => { e.preventDefault(); onClose(); }}
      onKeyDown={(e) => {
        // A modal dialog lets Tab leave for the browser's own controls; keep it cycling inside.
        if (e.key !== "Tab") return;
        const all = [...e.currentTarget.querySelectorAll<HTMLElement>("button, input, select, textarea, [tabindex]")]
          .filter((el) => !(el as HTMLButtonElement).disabled && el.tabIndex >= 0 && el.getClientRects().length > 0);
        const [first, last] = [all[0], all[all.length - 1]];
        if (!first) return;
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }}
      onPointerDown={(e) => {
        // A press on the backdrop lands on the dialog itself, outside its box.
        if (e.target !== e.currentTarget) return;
        const r = e.currentTarget.getBoundingClientRect();
        if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) onClose();
      }}>
      <div>
        <div className="mb-4 flex items-center justify-between">
          <h2 id={titleId} className="text-lg font-semibold">{t(kind === "stamp" ? "ed.createStamp" : "ed.createSignature")}</h2>
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
        {kind === "stamp" && <p className="mb-3 text-[14px] text-muted">{t("ed.stampHint")}</p>}
        {tabs.length > 1 && <div className="mb-3 flex gap-1 rounded-full bg-surface-2 p-1" role="tablist">
          {tabs.map((k) => (
            <button key={k} role="tab" aria-selected={tab === k} onClick={() => { setTab(k); setHasInk(false); }}
              className={`flex-1 rounded-full py-1.5 text-[14px] font-medium ${tab === k ? "bg-surface shadow-sm" : "text-muted"}`}>
              {t(`ed.${k}Tab`)}
            </button>
          ))}
        </div>}
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
                <button key={f.family} onClick={() => setScript(i)} aria-pressed={script === i}
                  className={`h-16 truncate rounded-xl border bg-white px-4 text-start text-[34px] ${script === i ? "border-brand" : "border-line"}`}
                  style={{ fontFamily: stack(f.family), color: ink }}>
                  {name || t("ed.typeName")}
                </button>
              ))}
            </div>
          </div>
        )}
        {tab === "upload" && (
          <label className="grid h-[200px] cursor-pointer place-items-center rounded-xl border-2 border-dashed border-line-strong bg-white text-muted focus-within:outline focus-within:outline-2 focus-within:outline-[var(--accent)]">
            {/* Visually hidden, not hidden: Tab reaches it and Enter opens the file picker. */}
            <input type="file" accept="image/*" className="sr-only" onChange={(e) => e.target.files?.[0] && onUpload(e.target.files[0])} />
            {upload ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={upload.url} alt="" className="max-h-[160px] max-w-[90%]" />
            ) : (
              <span>{t(kind === "stamp" ? "ed.chooseImage" : "ed.uploadTab")}</span>
            )}
          </label>
        )}
        <div className="mt-4 flex items-center gap-2">
          {tab !== "upload" && INKS.map((c) => (
            <button key={c} aria-label={t(colorKey(c))} aria-pressed={ink === c} onClick={() => setInk(c)}
              className="h-7 w-7 rounded-full ring-offset-2 ring-offset-[var(--surface)] aria-pressed:ring-2 aria-pressed:ring-[var(--ink)]" style={{ background: c }} />
          ))}
          {tab === "draw" && (
            <button className="btn btn-quiet btn-sm ms-2" onClick={() => {
              const c = canvas.current!;
              c.getContext("2d")!.clearRect(0, 0, c.width, c.height);
              setHasInk(false);
            }}>{t("ed.clear")}</button>
          )}
          <button className="btn btn-primary ms-auto" onClick={() => void finish()}
            disabled={(tab === "draw" && !hasInk) || (tab === "type" && !name.trim()) || (tab === "upload" && !upload)}>
            {t(kind === "stamp" ? "ed.useStamp" : "ed.useSignature")}
          </button>
        </div>
      </div>
    </dialog>
  );
}
