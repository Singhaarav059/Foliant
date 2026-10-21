"use client";

import { useEffect, useRef, useState } from "react";
import { Camera, CameraOff, Check, Circle, Maximize, RotateCcw, RotateCw, ScanSearch } from "lucide-react";
import { useI18n } from "../I18n";
import { detectQuad, pageSize, rotate, textTurn, warp, type Pt, type Quad, type Raster } from "@/lib/pdf/quad";

// Scan to PDF's camera. While the camera runs, the page's corners are found
// a few times a second and outlined. A capture opens the still with four
// draggable corners (found again on the full frame) and a preview of the
// flattened page; Keep warps the page flat at its true shape, turns it so the
// text is upright, and hands it on as a JPEG. Then the camera is back for the
// next page. The looks (Document, B/W, …) are applied when the PDF is built.

// After the first page the workspace swaps its empty view for the file list,
// which remounts this component: the camera stays on across that swap.
let shared: MediaStream | null = null;
let stopTimer: ReturnType<typeof setTimeout> | undefined;
let taken = 0;
const isLive = (s: MediaStream | null): s is MediaStream => !!s && s.getVideoTracks().some((tr) => tr.readyState === "live");
const stopShared = () => {
  shared?.getTracks().forEach((tr) => tr.stop());
  shared = null;
};

type Shot = { img: Raster; url: string; auto: Quad | null; autoTurn: number; preview: Raster };
const CORNERS = ["tl", "tr", "br", "bl"] as const;
const LIVE_SIDE = 360;
const PREVIEW_SIDE = 720;

const scaled = (q: Pt[], k: number) => q.map((p) => ({ x: p.x * k, y: p.y * k })) as Quad;
const inset = (w: number, h: number): Quad => [
  { x: w * 0.1, y: h * 0.1 }, { x: w * 0.9, y: h * 0.1 }, { x: w * 0.9, y: h * 0.9 }, { x: w * 0.1, y: h * 0.9 },
];
const whole = (w: number, h: number): Quad => [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }];

function toCanvas(r: Raster) {
  const c = document.createElement("canvas");
  c.width = r.width;
  c.height = r.height;
  c.getContext("2d")!.putImageData(new ImageData(r.data as Uint8ClampedArray<ArrayBuffer>, r.width, r.height), 0, 0);
  return c;
}

// A smaller copy of a raster for the preview (nearest pixel is plenty).
function shrink(r: Raster, side: number): Raster {
  const k = Math.min(1, side / Math.max(r.width, r.height));
  if (k === 1) return r;
  const w = Math.max(1, Math.round(r.width * k)), h = Math.max(1, Math.round(r.height * k));
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const sy = Math.min(r.height - 1, Math.floor(y / k));
    for (let x = 0; x < w; x++) {
      const i = (sy * r.width + Math.min(r.width - 1, Math.floor(x / k))) * 4, o = (y * w + x) * 4;
      out[o] = r.data[i]; out[o + 1] = r.data[i + 1]; out[o + 2] = r.data[i + 2]; out[o + 3] = 255;
    }
  }
  return { data: out, width: w, height: h };
}

// The flattened page, `turn` degrees clockwise.
function flatten(img: Raster, q: Quad, turn: number, maxSide: number) {
  const s = pageSize(q, img.width, img.height, maxSide);
  return rotate(warp(img, q, s.width, s.height), turn);
}

export function Scanner({ onCapture }: { onCapture: (f: File) => void }) {
  const { t } = useI18n();
  const video = useRef<HTMLVideoElement>(null);
  const [stream, setStream] = useState<MediaStream | null>(() => (isLive(shared) ? shared : null));
  const [denied, setDenied] = useState(false);
  const [flash, setFlash] = useState(false);
  const [found, setFound] = useState<{ q: Quad; w: number; h: number } | null>(null);
  const [shot, setShot] = useState<Shot | null>(null);
  const [corners, setCorners] = useState<Quad | null>(null);
  const [turn, setTurn] = useState(0);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    clearTimeout(stopTimer);
    // Unmounting (not stopping): give a remount a moment to take the camera over.
    return () => { stopTimer = setTimeout(stopShared, 1500); };
  }, []);

  useEffect(() => {
    const v = video.current;
    if (!v || !stream) return;
    if (v.srcObject !== stream) v.srcObject = stream;
    // A remounted element doesn't always start on its own with a reused stream.
    v.play().catch(() => {});
  }, [stream, shot]);

  useEffect(() => () => { if (shot) URL.revokeObjectURL(shot.url); }, [shot]);

  // Live outline: find the page on a small copy of the frame, a few times a second.
  useEffect(() => {
    if (!stream || shot) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const small = document.createElement("canvas");
    const tick = () => {
      const v = video.current;
      if (v && v.videoWidth) {
        const k = Math.min(1, LIVE_SIDE / Math.max(v.videoWidth, v.videoHeight));
        small.width = Math.round(v.videoWidth * k);
        small.height = Math.round(v.videoHeight * k);
        const ctx = small.getContext("2d", { willReadFrequently: true })!;
        ctx.drawImage(v, 0, 0, small.width, small.height);
        const q = detectQuad(ctx.getImageData(0, 0, small.width, small.height));
        setFound(q ? { q: scaled(q, 1 / k), w: v.videoWidth, h: v.videoHeight } : null);
      }
      if (!stopped) timer = setTimeout(tick, 220);
    };
    timer = setTimeout(tick, 120);
    return () => { stopped = true; clearTimeout(timer); };
  }, [stream, shot]);

  const start = async () => {
    try {
      const s = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" }, width: { ideal: 2560 }, height: { ideal: 1920 } },
        audio: false,
      });
      shared = s;
      setStream(s);
      setDenied(false);
    } catch {
      setDenied(true);
    }
  };

  const stop = () => {
    stopShared();
    setStream(null);
    setShot(null);
    setFound(null);
  };

  const capture = () => {
    const v = video.current;
    if (!v || !v.videoWidth) return;
    const c = document.createElement("canvas");
    c.width = v.videoWidth;
    c.height = v.videoHeight;
    const ctx = c.getContext("2d", { willReadFrequently: true })!;
    ctx.drawImage(v, 0, 0);
    const img = ctx.getImageData(0, 0, c.width, c.height);
    setFlash(true);
    setTimeout(() => setFlash(false), 140);
    // The full frame gives sharper corners than the live outline.
    const auto = detectQuad(img);
    const preview = shrink(img, PREVIEW_SIDE);
    const k = preview.width / img.width;
    const autoTurn = auto ? textTurn(flatten(preview, scaled(auto, k), 0, PREVIEW_SIDE)) : 0;
    c.toBlob((b) => {
      if (!b) return;
      setShot({ img, url: URL.createObjectURL(b), auto, autoTurn, preview });
      setCorners(auto ?? inset(img.width, img.height));
      setTurn(autoTurn);
    }, "image/jpeg", 0.9);
  };

  const keep = () => {
    if (!shot || !corners) return;
    setBusy(true);
    // Let the busy state paint before the warp blocks the thread.
    setTimeout(() => {
      const page = toCanvas(flatten(shot.img, corners, turn, 3000));
      page.toBlob((b) => {
        setBusy(false);
        if (!b) return;
        taken++;
        setShot(null);
        setCorners(null);
        onCapture(new File([b], `scan-${taken}.jpg`, { type: "image/jpeg" }));
      }, "image/jpeg", 0.92);
    }, 30);
  };

  if (!stream) {
    return (
      <div className="flex flex-col items-start gap-2">
        <button className="btn btn-quiet" onClick={start}><Camera size={18} /> {t("ws.camera")}</button>
        {denied && <p className="flex items-center gap-1.5 text-[14px] text-muted"><CameraOff size={15} /> {t("ws.cameraDenied")}</p>}
      </div>
    );
  }

  if (shot && corners) {
    return (
      <Adjust shot={shot} corners={corners} setCorners={setCorners} turn={turn} setTurn={setTurn} busy={busy}
        onKeep={keep} onRetake={() => { setShot(null); setCorners(null); }} />
    );
  }

  return (
    <div className="w-full basis-full">
      <div className="relative mx-auto w-full max-w-[640px] overflow-hidden rounded-xl bg-black">
        <video ref={video} autoPlay playsInline muted className="block max-h-[60vh] w-full object-contain" />
        {found && (
          <svg className="pointer-events-none absolute inset-0 h-full w-full" viewBox={`0 0 ${found.w} ${found.h}`} preserveAspectRatio="xMidYMid meet" aria-hidden>
            <polygon points={found.q.map((p) => `${p.x},${p.y}`).join(" ")} fill="rgb(59 130 246 / 0.18)" stroke="rgb(96 165 250)" strokeWidth={3} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
          </svg>
        )}
        <div className={`pointer-events-none absolute inset-0 bg-white transition-opacity duration-150 ${flash ? "opacity-70" : "opacity-0"}`} />
        <p role="status" className="absolute inset-x-0 top-3 mx-auto w-fit max-w-[90%] rounded-full bg-black/60 px-3 py-1 text-center text-[13px] text-white">
          {found ? t("ws.scanFound") : t("ws.scanLooking")}
        </p>
        <div className="absolute inset-x-0 bottom-4 flex items-center justify-center">
          {taken > 0 && (
            <span className="absolute start-4 rounded-full bg-black/60 px-3 py-1 text-[13px] text-white">{t("ws.scanCount", { n: taken })}</span>
          )}
          <button className="grid h-16 w-16 place-items-center rounded-full bg-white text-black shadow-lg active:scale-95" aria-label={t("ws.capture")} onClick={capture}>
            <Circle size={52} strokeWidth={1.5} />
          </button>
          <button className="btn btn-sm absolute end-4 bg-black/60 text-white" onClick={stop}>
            {t("ws.scanDone")}
          </button>
        </div>
      </div>
    </div>
  );
}

function Adjust({ shot, corners, setCorners, turn, setTurn, busy, onKeep, onRetake }: {
  shot: Shot; corners: Quad; setCorners: (q: Quad) => void; turn: number; setTurn: (n: number) => void; busy: boolean;
  onKeep: () => void; onRetake: () => void;
}) {
  const { t } = useI18n();
  const { width: W, height: H } = shot.img;
  const box = useRef<HTMLDivElement>(null);
  const preview = useRef<HTMLCanvasElement>(null);
  const drag = useRef<{ i: number; dx: number; dy: number } | null>(null);

  // Redraw the flattened preview when the corners or the turn change.
  useEffect(() => {
    const id = setTimeout(() => {
      const c = preview.current;
      if (!c) return;
      const k = shot.preview.width / W;
      const flat = flatten(shot.preview, scaled(corners, k), turn, 360);
      c.width = flat.width;
      c.height = flat.height;
      c.getContext("2d")!.putImageData(new ImageData(flat.data as Uint8ClampedArray<ArrayBuffer>, flat.width, flat.height), 0, 0);
    }, 60);
    return () => clearTimeout(id);
  }, [shot, corners, turn, W]);

  const at = (e: React.PointerEvent): Pt => {
    const r = box.current!.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * W, y: ((e.clientY - r.top) / r.height) * H };
  };
  const move = (i: number, p: Pt) => {
    const next = [...corners] as Quad;
    next[i] = { x: Math.min(W, Math.max(0, p.x)), y: Math.min(H, Math.max(0, p.y)) };
    setCorners(next);
  };
  const nudge = (i: number, e: React.KeyboardEvent) => {
    const step = (Math.max(W, H) / 200) * (e.shiftKey ? 10 : 1);
    const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
    if (!d) return;
    e.preventDefault();
    move(i, { x: corners[i].x + d[0], y: corners[i].y + d[1] });
  };
  const outline = corners.map((p) => `${p.x},${p.y}`).join(" ");

  return (
    <div className="w-full basis-full">
      <p className="mb-3 text-center text-[14px] text-muted">{shot.auto ? t("ws.scanAdjust") : t("ws.scanNoEdges")}</p>
      <div className="flex flex-col items-center gap-4 md:flex-row md:items-start md:justify-center">
        <div ref={box} className="relative touch-none select-none"
          style={{ aspectRatio: `${W} / ${H}`, width: `min(100%, calc(60vh * ${W / H}))` }}>
          {/* eslint-disable-next-line @next/next/no-img-element -- a local blob: URL */}
          <img src={shot.url} alt={t("ws.scanPhoto")} className="absolute inset-0 h-full w-full rounded-lg" draggable={false} />
          <svg className="pointer-events-none absolute inset-0 h-full w-full" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden>
            <path d={`M0 0H${W}V${H}H0Z M${outline.replaceAll(" ", " L")}Z`} fillRule="evenodd" fill="rgb(0 0 0 / 0.45)" />
            <polygon points={outline} fill="none" stroke="rgb(96 165 250)" strokeWidth={2.5} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
          </svg>
          {corners.map((p, i) => (
            <button key={CORNERS[i]} type="button" aria-label={t(`ws.corner.${CORNERS[i]}`)}
              className="absolute grid h-11 w-11 -translate-x-1/2 -translate-y-1/2 cursor-grab touch-none place-items-center rounded-full focus-visible:outline-2 focus-visible:outline-offset-2 active:cursor-grabbing"
              style={{ left: `${(p.x / W) * 100}%`, top: `${(p.y / H) * 100}%` }}
              onPointerDown={(e) => {
                e.currentTarget.setPointerCapture(e.pointerId);
                const q = at(e);
                drag.current = { i, dx: corners[i].x - q.x, dy: corners[i].y - q.y };
              }}
              onPointerMove={(e) => {
                const d = drag.current;
                if (!d || d.i !== i) return;
                const q = at(e);
                move(i, { x: q.x + d.dx, y: q.y + d.dy });
              }}
              onPointerUp={() => { drag.current = null; }}
              onPointerCancel={() => { drag.current = null; }}
              onKeyDown={(e) => nudge(i, e)}>
              <span className="block h-5 w-5 rounded-full border-2 border-white bg-blue-500 shadow-md" />
            </button>
          ))}
        </div>
        <figure className="flex flex-col items-center gap-2">
          {/* A fixed box, so redrawing the preview never shifts the photo. */}
          <div className="grid h-[220px] w-[220px] place-items-center">
            <canvas ref={preview} width={1} height={1} role="img" aria-label={t("ws.scanPreview")} className="max-h-full max-w-full rounded border border-black/10 bg-white shadow-sm" />
          </div>
          <div className="flex gap-1">
            <button type="button" className="btn btn-quiet btn-sm" aria-label={t("ws.rotateLeft")} onClick={() => setTurn((turn + 270) % 360)}><RotateCcw size={16} /></button>
            <button type="button" className="btn btn-quiet btn-sm" aria-label={t("ws.rotateRight")} onClick={() => setTurn((turn + 90) % 360)}><RotateCw size={16} /></button>
          </div>
        </figure>
      </div>
      <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
        <button type="button" className="btn btn-quiet btn-sm" onClick={onRetake}>{t("ws.retake")}</button>
        <button type="button" className="btn btn-quiet btn-sm" onClick={() => setCorners(whole(W, H))}><Maximize size={16} /> {t("ws.scanWhole")}</button>
        {shot.auto && (
          <button type="button" className="btn btn-quiet btn-sm" onClick={() => { setCorners(shot.auto!); setTurn(shot.autoTurn); }}><ScanSearch size={16} /> {t("ws.scanAuto")}</button>
        )}
        <button type="button" className="btn btn-primary" disabled={busy} onClick={onKeep}><Check size={18} /> {t("ws.scanKeep")}</button>
      </div>
    </div>
  );
}
