// PDFium compiled to WebAssembly (EmbedPDF's build, MIT; PDFium itself is
// BSD/Apache). Used for true redaction: EPDFText_RedactInQuads removes the
// text, image pixels and vector shapes under each box from the page content,
// then FPDFPage_GenerateContent writes the page back out.

import { VENDOR } from "../vendor";

type Pdfium = Awaited<ReturnType<typeof import("@embedpdf/pdfium").init>>;

// Tests read the file from disk instead.
export const pdfiumWasm = {
  load: async (): Promise<ArrayBuffer> => (await fetch(`${VENDOR}pdfium.wasm`)).arrayBuffer(),
};

let loading: Promise<Pdfium> | null = null;

export function pdfium() {
  loading ??= (async () => {
    const { init } = await import("@embedpdf/pdfium");
    const m = await init({ wasmBinary: await pdfiumWasm.load() });
    m.PDFiumExt_Init();
    return m;
  })();
  // A failed load shouldn't stick: the next call tries again.
  loading.catch(() => (loading = null));
  return loading;
}

// Boxes in PDF user space (points, bottom-left origin).
export type Box = { x0: number; y0: number; x1: number; y1: number };

// Redacts each page's boxes in place and draws black boxes over them.
// Returns the new file and the pages PDFium couldn't redact.
export async function redactInPlace(bytes: Uint8Array, boxes: Map<number, Box[]>): Promise<{ bytes: Uint8Array; failed: number[] }> {
  const m = await pdfium();
  const { malloc, free } = m.pdfium.wasmExports as unknown as { malloc: (n: number) => number; free: (p: number) => void };
  // Read the heap each time: it's replaced when WASM memory grows.
  const heap = () => (m.pdfium as unknown as { HEAPU8: Uint8Array }).HEAPU8;
  const file = malloc(bytes.length);
  heap().set(bytes, file);
  const doc = m.FPDF_LoadMemDocument(file, bytes.length, "");
  if (!doc) {
    free(file);
    throw new Error(`PDFium could not open the file (error ${m.FPDF_GetLastError()})`);
  }
  const failed: number[] = [];
  try {
    for (const [index, list] of boxes) {
      const page = m.FPDF_LoadPage(doc, index);
      if (!page) {
        failed.push(index);
        continue;
      }
      // FS_QUADPOINTSF: top-left, top-right, bottom-left, bottom-right as float pairs.
      const quads = malloc(32 * list.length);
      list.forEach((b, i) => {
        [b.x0, b.y1, b.x1, b.y1, b.x0, b.y0, b.x1, b.y0].forEach((v, k) => m.pdfium.setValue(quads + i * 32 + k * 4, v, "float"));
      });
      try {
        // Arguments: page, quads, count, also inside form XObjects, draw black boxes.
        const ok = m.EPDFText_RedactInQuads(page, quads, list.length, true, true) && m.FPDFPage_GenerateContent(page);
        if (!ok) failed.push(index);
      } finally {
        free(quads);
        m.FPDF_ClosePage(page);
      }
    }
    const writer = m.PDFiumExt_OpenFileWriter();
    try {
      if (!m.PDFiumExt_SaveAsCopy(doc, writer)) throw new Error("PDFium could not save the file");
      const size = m.PDFiumExt_GetFileWriterSize(writer);
      const data = malloc(size);
      m.PDFiumExt_GetFileWriterData(writer, data, size);
      const out = heap().slice(data, data + size);
      free(data);
      return { bytes: out, failed };
    } finally {
      m.PDFiumExt_CloseFileWriter(writer);
    }
  } finally {
    m.FPDF_CloseDocument(doc);
    free(file);
  }
}
