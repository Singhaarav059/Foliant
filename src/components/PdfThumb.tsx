"use client";

import { useEffect, useRef, useState } from "react";
import { thumbUrl } from "@/lib/pdf/thumbs";

// A lazily rendered page image. Renders only once it scrolls near the viewport.
export function PdfThumb({
  file, page, width, rotate = 0, className = "", alt = "",
}: { file: Blob; page: number; width: number; rotate?: number; className?: string; alt?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [img, setImg] = useState<{ url: string; ratio: number } | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ctrl = new AbortController();
    const io = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        io.disconnect();
        thumbUrl(file, page, width, ctrl.signal).then(setImg).catch((e) => e?.name !== "AbortError" && setFailed(true));
      },
      { rootMargin: "400px" },
    );
    io.observe(el);
    return () => {
      io.disconnect();
      ctrl.abort();
    };
  }, [file, page, width]);

  const ratio = img?.ratio ?? 1.414;
  const sideways = rotate % 180 !== 0;
  // Keep the box at the rotated shape so neighbouring cards don't jump.
  const boxH = sideways ? width / ratio : width * ratio;
  const fit = sideways ? Math.min(1, boxH / width) : 1;

  return (
    <div ref={ref} className={`relative grid place-items-center overflow-hidden ${className}`} style={{ width, height: boxH }}>
      {img ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={img.url}
          alt={alt}
          draggable={false}
          className="max-w-none bg-white shadow-[0_0_0_1px_var(--line)] transition-transform duration-200"
          style={{ width: width * fit, height: width * ratio * fit, transform: `rotate(${rotate}deg)` }}
        />
      ) : (
        <div className={`h-full w-full rounded bg-surface-2 ${failed ? "" : "animate-pulse"}`} />
      )}
    </div>
  );
}
