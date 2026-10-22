"use client";

import { useEffect, useMemo, useState } from "react";
import { useI18n } from "../I18n";
import { PdfThumb } from "../PdfThumb";
import { docFor } from "@/lib/pdf/thumbs";
import { closePdf, openPdf, pageSet, renderPage } from "@/lib/pdf/common";

export type Stamp = "watermark" | "pageNumbers" | "headerFooter";
export const STAMPS: string[] = ["watermark", "pageNumbers", "headerFooter"];
const WIDTH = 300;

// A live preview for the stamping tools (P2-12): the first page they draw
// on, with the marks over it. The marks come from the same code as the
// output (edit.ts markLayer, drawn onto blank pages of the same size), rendered
// transparent and laid over the page's thumbnail. Opacity is applied by CSS,
// so dragging that slider needs no new drawing.
export function StampPreview({ tool, file, options }: { tool: Stamp; file: File; options: Record<string, unknown> }) {
  const { t, tOr } = useI18n();
  const [doc, setDoc] = useState<{ total: number } | null>(null);
  const [layer, setLayer] = useState<{ url: string; key: string } | null>(null);

  useEffect(() => {
    let live = true;
    docFor(file).then((d) => live && setDoc({ total: d.numPages })).catch(() => {});
    return () => {
      live = false;
    };
  }, [file]);

  const index = doc ? firstMarked(tool, options, doc.total) : null;
  // Everything that changes the marks' shape or place; not opacity, not the layer.
  const key = useMemo(() => JSON.stringify({ ...options, opacity: undefined, layer: undefined, index },
    (_, v) => (v instanceof File ? `${v.name}:${v.size}:${v.lastModified}` : v)), [options, index]);

  useEffect(() => {
    if (!doc || index === null) return;
    let live = true;
    let url = "";
    // A short pause, so typing a watermark draws once rather than per letter.
    const timer = setTimeout(async () => {
      try {
        const page = await (await docFor(file)).getPage(index + 1);
        const view = page.getViewport({ scale: 1 });
        const { markLayer } = await import("@/lib/pdf/edit");
        const bytes = await markLayer(tool, file, options, { w: view.width, h: view.height, index, total: doc.total },
          { page: tOr("ws.page", "Page {n}"), pageOf: tOr("ws.processingPage", "Page {n} of {total}"), nOf: tOr("fmt.nOfTotal", "{n} of {total}") });
        if (!live) return;
        const marks = await openPdf(bytes);
        try {
          const dpr = Math.min(2, window.devicePixelRatio || 1);
          const canvas = await renderPage(await marks.getPage(1), (WIDTH * dpr) / view.width, "rgba(0,0,0,0)");
          const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/png"));
          canvas.width = canvas.height = 0;
          if (!blob || !live) return;
          url = URL.createObjectURL(blob);
          setLayer({ url, key });
        } finally {
          void closePdf(marks);
        }
      } catch {
        // A preview that can't be drawn (an image not chosen yet, say) shows the page alone.
        if (live) setLayer(null);
      }
    }, 120);
    return () => {
      live = false;
      clearTimeout(timer);
      if (url) setTimeout(() => URL.revokeObjectURL(url), 1000);
    };
    // `key` stands for the options that matter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, file, key, tool]);

  if (!doc) return null;
  const shown = index ?? 0;
  const opacity = tool === "watermark" ? Math.min(1, Math.max(0, Number(options.opacity ?? 100) / 100)) : 1;
  return (
    <figure className="mt-6" data-preview={tool} data-page={shown}>
      <div className="relative w-max">
        <PdfThumb file={file} page={shown} width={WIDTH} className="rounded-sm" />
        {layer && index !== null && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={layer.url}
            alt=""
            data-marks={layer.key === key ? "ready" : "stale"}
            className="pointer-events-none absolute inset-0 m-auto"
            style={{ width: WIDTH, opacity, mixBlendMode: options.layer === "under" ? "multiply" : undefined }}
          />
        )}
      </div>
      <figcaption className="mt-2 text-[13px] text-muted">{t("ws.preview", { n: shown + 1 })}</figcaption>
    </figure>
  );
}

// The page a stamping tool's preview shows: the first one it draws on.
function firstMarked(tool: string, o: Record<string, unknown>, total: number) {
  const chosen = [...pageSet(String(o.pageRange ?? ""), total)].sort((a, b) => a - b);
  const skip = tool === "pageNumbers" ? Number(o.skipFirstPages) || 0 : tool === "headerFooter" ? Number(o.hfSkipFirst) || 0 : 0;
  const skipLast = tool === "pageNumbers" ? Number(o.skipLastPages) || 0 : 0;
  return chosen.find((i) => i >= skip && i < total - skipLast) ?? null;
}
