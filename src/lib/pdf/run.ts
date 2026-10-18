"use client";

import { LIGHT_OFFICE, type ToolId } from "../tools";
import { baseName, type Output, type Progress } from "./common";
import { forFile, PdfError, ServerError } from "./errors";
import { STATIC } from "@/lib/mode";

type Opts = Record<string, unknown>;
const s = (v: unknown) => String(v ?? "");
const b = (v: unknown) => Boolean(v);
const n = (v: unknown) => Number(v);

// Runs the per-file loop for tools that take several files and treat each alone.
// A failure names the file it happened on.
async function each(files: File[], progress: Progress | undefined, fn: (f: File, p: Progress) => Promise<Output[]>) {
  const out: Output[] = [];
  for (let i = 0; i < files.length; i++) {
    const res = await forFile(files[i], () => fn(files[i], (d, t) => progress?.(i + d / Math.max(1, t), files.length)));
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
      }).catch((e) => {
        // qpdf can't open a file that already has an open password.
        throw (e as { code?: string }).code === "encrypted" ? new PdfError("already_encrypted", f.name, e) : e;
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
        // LibreOffice writes the PDF unless Standard is chosen; formats only it reads always use it.
        // Automatic (the workspace has already ruled out phones) prints instead when
        // LibreOffice can't run here or fails. The whole batch goes one way, so
        // results are all PDFs or all print pages.
        const ext = (f: File) => f.name.split(".").pop()?.toLowerCase() ?? "";
        const light = files.every((f) => LIGHT_OFFICE.includes(ext(f)));
        const print = async () => {
          const { printable } = await import("@/lib/office/print");
          return each(files, progress, async (f) => [await printable(f, { orientation: s(o.orientation || "auto") })]);
        };
        if (light && o.fidelity === "standard") return print();
        const { officeAvailable, officeToPdf } = await import("@/lib/office/libreoffice");
        const fallback = light && o.fidelity !== "high";
        if (fallback && !officeAvailable()) return print();
        try {
          return await each(files, progress, async (f, p) => [await officeToPdf(f, p)]);
        } catch (e) {
          if (!fallback) throw e;
          return print();
        }
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

// Loads the code runTool(id) loads, without running anything, for
// src/lib/offline.ts. The imports are written here, like runTool's, so they
// fetch the same chunks a real run does. OCR and Office conversion fetch
// tens of megabytes on first use and are left to that first use.
export async function prepare(id: ToolId): Promise<unknown> {
  switch (id) {
    case "merge":
    case "split":
    case "rotate":
      return (await import("./organize")).prepare();
    case "compress":
    case "repair":
      return (await import("./optimize")).prepare();
    case "jpgToPdf":
    case "scan":
      return import("./convert");
    case "pdfToJpg":
    case "pdfToMarkdown":
    case "pdfToPdfa":
      return (await import("./convert")).prepare("pdf");
    case "pdfToWord":
      return (await import("./convert")).prepare("word");
    case "pdfToExcel":
      return (await import("./convert")).prepare("excel");
    case "pdfToPpt":
      return (await import("./convert")).prepare("ppt");
    case "pageNumbers":
    case "watermark":
      return import("./edit");
    case "protect":
    case "unlock":
      return (await import("./security")).prepare();
    default:
      return null;
  }
}

function hostName(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "page";
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
        let text: unknown;
        try {
          text = JSON.parse(await (xhr.response as Blob).text()).error;
        } catch {
          /* not JSON */
        }
        reject(new ServerError(xhr.status, typeof text === "string" ? text : undefined));
      }
    };
    xhr.onerror = () => reject(new ServerError(0));
    xhr.send(body);
  });
}
