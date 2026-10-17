"use client";

import type { ToolId } from "../tools";
import { baseName, type Output, type Progress } from "./common";
import { STATIC } from "@/lib/mode";

type Opts = Record<string, unknown>;
const s = (v: unknown) => String(v ?? "");
const b = (v: unknown) => Boolean(v);
const n = (v: unknown) => Number(v);

// Runs the per-file loop for tools that take several files and treat each alone.
async function each(files: File[], progress: Progress | undefined, fn: (f: File, p: Progress) => Promise<Output[]>) {
  const out: Output[] = [];
  for (let i = 0; i < files.length; i++) {
    const res = await fn(files[i], (d, t) => progress?.(i + d / Math.max(1, t), files.length));
    out.push(...res);
    progress?.(i + 1, files.length);
  }
  return out;
}

export type Labels = { page: string; pageOf: string; nOf: string };

export async function runTool(id: ToolId, files: File[], o: Opts, progress?: Progress, labels?: Labels): Promise<Output[]> {
  switch (id) {
    case "merge": {
      const { merge } = await import("./organize");
      return merge(files, { bookmarks: b(o.bookmarks) }, progress);
    }
    case "split": {
      const { split } = await import("./organize");
      return split(files[0], { splitMode: s(o.splitMode), ranges: s(o.ranges), every: n(o.every), maxMb: n(o.maxMb), mergeRanges: b(o.mergeRanges) }, progress);
    }
    case "rotate": {
      const { rotateAll } = await import("./organize");
      return each(files, progress, (f) => rotateAll(f, n(o.angle)));
    }
    case "compress": {
      const { compress } = await import("./optimize");
      return each(files, progress, (f, p) => compress(f, { level: s(o.level) }, p));
    }
    case "repair": {
      const { repair } = await import("./optimize");
      return each(files, progress, (f) => repair(f));
    }
    case "ocr": {
      const { ocr } = await import("./optimize");
      return each(files, progress, (f, p) => ocr(f, { ocrLang: s(o.ocrLang), dpi: s(o.dpi), ocrEngine: s(o.ocrEngine) }, p));
    }
    case "jpgToPdf": {
      const { imagesToPdf } = await import("./convert");
      return imagesToPdf(files, files.map((f) => f.name), {
        orientation: s(o.orientation), pageSize: s(o.pageSize), margin: s(o.margin), separate: b(o.separate),
      }, progress);
    }
    case "scan": {
      const { imagesToPdf, scanFilter } = await import("./convert");
      const filtered = await Promise.all(files.map((f) => scanFilter(f, s(o.filter))));
      return imagesToPdf(filtered, files.map((_, i) => `scan-${i + 1}`), {
        orientation: "auto", pageSize: s(o.pageSize), margin: "none", separate: false,
      }, progress).then((r) => r.map((x) => ({ ...x, name: `scan-${new Date().toISOString().slice(0, 10)}.pdf` })));
    }
    case "pdfToJpg": {
      const { pdfToImages, extractImages } = await import("./convert");
      return each(files, progress, (f, p) =>
        s(o.jpgMode) === "images" ? extractImages(f) : pdfToImages(f, { dpi: s(o.dpi), format: s(o.format) }, p));
    }
    case "pdfToWord": {
      const { pdfToWord } = await import("./convert");
      return each(files, progress, (f, p) => pdfToWord(f, { wordMode: s(o.wordMode) }, p));
    }
    case "pdfToPpt": {
      const { pdfToPpt } = await import("./convert");
      return each(files, progress, (f, p) => pdfToPpt(f, { pptText: b(o.pptText) }, p));
    }
    case "pdfToExcel": {
      const { pdfToExcel } = await import("./convert");
      return each(files, progress, (f, p) => pdfToExcel(f, { sheetPer: s(o.sheetPer) }, p));
    }
    case "pdfToPdfa": {
      const { pdfToPdfa } = await import("./convert");
      return each(files, progress, (f, p) => pdfToPdfa(f, { pdfaDpi: s(o.pdfaDpi), keepText: b(o.keepText) }, p));
    }
    case "pdfToMarkdown": {
      const { pdfToMarkdown } = await import("./convert");
      return each(files, progress, (f, p) => pdfToMarkdown(f, { pageBreaks: b(o.pageBreaks) }, p));
    }
    case "pageNumbers": {
      const { pageNumbers } = await import("./edit");
      return each(files, progress, (f) => pageNumbers(f, {
        position: s(o.position), numberFormat: s(o.numberFormat), startAt: n(o.startAt), pageRange: s(o.pageRange),
        skipFirst: b(o.skipFirst), fontSize: n(o.fontSize), color: s(o.color), facing: b(o.facing),
        labels,
      }));
    }
    case "watermark": {
      const { watermark } = await import("./edit");
      return each(files, progress, (f) => watermark(f, {
        markType: s(o.markType), markText: s(o.markText), markImage: o.markImage as File | undefined,
        fontSize: n(o.fontSize), color: s(o.color), imageScale: n(o.imageScale), position: s(o.position),
        mosaic: b(o.mosaic), opacity: n(o.opacity), rotation: s(o.rotation), layer: s(o.layer), pageRange: s(o.pageRange),
      }));
    }
    case "protect": {
      const { protect } = await import("./security");
      return each(files, progress, (f) => protect(f, {
        password: s(o.password), allowPrint: b(o.allowPrint), allowCopy: b(o.allowCopy), allowModify: b(o.allowModify),
      }));
    }
    case "unlock": {
      const { unlock } = await import("./security");
      return each(files, progress, (f) => unlock(f, { password: s(o.password) }));
    }
    case "wordToPdf":
    case "pptToPdf":
    case "excelToPdf": {
      if (STATIC) {
        const { printable } = await import("@/lib/office/print");
        return each(files, progress, async (f) => [await printable(f, { orientation: s(o.orientation || "auto") })]);
      }
      return each(files, progress, async (f, p) => {
        const form = new FormData();
        form.append("file", f);
        form.append("orientation", s(o.orientation || "auto"));
        const blob = await upload("/api/convert/office", form, p);
        return [{ name: `${baseName(f.name)}.pdf`, blob }];
      });
    }
    case "htmlToPdf": {
      if (STATIC) {
        const { printable } = await import("@/lib/office/print");
        return [await printable(files[0], { pageSize: s(o.pageSize), orientation: s(o.orientation) })];
      }
      const form = new FormData();
      if (files[0]) form.append("file", files[0]);
      else form.append("url", s(o.url));
      for (const k of ["pageSize", "orientation", "screenWidth", "hideOverlays"]) form.append(k, s(o[k]));
      const blob = await upload("/api/convert/html", form, progress);
      const name = files[0] ? baseName(files[0].name) : hostName(s(o.url));
      return [{ name: `${name}.pdf`, blob }];
    }
    default:
      throw new Error(`${id} needs its own workspace`);
  }
}

function hostName(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "page";
  }
}

export class ServerError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

// XHR rather than fetch so uploads can report progress.
export function upload(url: string, body: FormData, progress?: Progress): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    xhr.responseType = "blob";
    xhr.upload.onprogress = (e) => e.lengthComputable && progress?.(e.loaded / e.total * 0.6, 1);
    xhr.onprogress = () => progress?.(0.9, 1);
    xhr.onload = async () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve(xhr.response);
      else {
        let msg = `Server error ${xhr.status}`;
        try {
          msg = JSON.parse(await (xhr.response as Blob).text()).error ?? msg;
        } catch {
          /* not JSON */
        }
        reject(new ServerError(msg, xhr.status));
      }
    };
    xhr.onerror = () => reject(new ServerError("Network error", 0));
    xhr.send(body);
  });
}
