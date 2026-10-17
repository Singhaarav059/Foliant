"use client";

import { useEffect, useRef, useState } from "react";
import { Camera, CameraOff, Circle } from "lucide-react";
import { useI18n } from "../I18n";

// Live camera capture for Scan to PDF. Each capture becomes a JPEG File.
export function Scanner({ onCapture }: { onCapture: (f: File) => void }) {
  const { t } = useI18n();
  const video = useRef<HTMLVideoElement>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [denied, setDenied] = useState(false);
  const [flash, setFlash] = useState(false);
  const count = useRef(0);

  useEffect(() => () => stream?.getTracks().forEach((tr) => tr.stop()), [stream]);

  const start = async () => {
    try {
      const s = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" }, width: { ideal: 2560 }, height: { ideal: 1920 } },
        audio: false,
      });
      setStream(s);
      setDenied(false);
      if (video.current) video.current.srcObject = s;
    } catch {
      setDenied(true);
    }
  };

  useEffect(() => {
    if (video.current && stream) video.current.srcObject = stream;
  }, [stream]);

  const capture = () => {
    const v = video.current;
    if (!v || !v.videoWidth) return;
    const c = document.createElement("canvas");
    c.width = v.videoWidth;
    c.height = v.videoHeight;
    c.getContext("2d")!.drawImage(v, 0, 0);
    c.toBlob((b) => {
      if (!b) return;
      count.current++;
      onCapture(new File([b], `scan-${count.current}.jpg`, { type: "image/jpeg" }));
    }, "image/jpeg", 0.92);
    setFlash(true);
    setTimeout(() => setFlash(false), 140);
  };

  if (!stream) {
    return (
      <div className="flex flex-col items-start gap-2">
        <button className="btn btn-quiet" onClick={start}><Camera size={18} /> {t("ws.camera")}</button>
        {denied && <p className="flex items-center gap-1.5 text-[14px] text-muted"><CameraOff size={15} /> {t("ws.cameraDenied")}</p>}
      </div>
    );
  }
  return (
    <div className="relative mx-auto w-full max-w-[640px] overflow-hidden rounded-xl bg-black">
      <video ref={video} autoPlay playsInline muted className="block max-h-[60vh] w-full object-contain" />
      <div className={`pointer-events-none absolute inset-0 bg-white transition-opacity duration-150 ${flash ? "opacity-70" : "opacity-0"}`} />
      <div className="absolute inset-x-0 bottom-4 flex items-center justify-center gap-3">
        <button className="grid h-16 w-16 place-items-center rounded-full bg-white text-black shadow-lg active:scale-95" aria-label={t("ws.capture")} onClick={capture}>
          <Circle size={52} strokeWidth={1.5} />
        </button>
        <button className="btn btn-sm absolute end-4 bg-black/60 text-white" onClick={() => { stream.getTracks().forEach((tr) => tr.stop()); setStream(null); }}>
          {t("ws.cancel")}
        </button>
      </div>
    </div>
  );
}
