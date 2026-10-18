"use client";

// Opens a PDF for editing the way readers open it. pdf-lib reads a file from
// top to bottom, so where an object number is defined twice it takes the
// last copy, while readers follow the cross-reference table; it refuses any
// encrypted file, even one with only an owner password, which every viewer
// opens without asking. So the file first goes through qpdf, which follows
// the table, decrypts with the empty password when that is all it takes, and
// leaves out what nothing refers to. Streams stay as they are stored (nothing
// is inflated). When qpdf can't read the file (damage it doesn't repair, or
// no qpdf at all, offline), pdf-lib reads the original bytes.
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFPage, PDFPageLeaf, PDFRef } from "pdf-lib";
import { PdfError, toPdfError } from "./errors";
import { QpdfError, runQpdf } from "./qpdf";

export type Opened = {
  doc: PDFDocument;
  // The bytes `doc` was read from: what readers show, decrypted.
  bytes: Uint8Array;
  // The file had an owner password (restrictions), which the copy no longer has.
  decrypted: boolean;
};

const isEncrypted = (e: unknown) => /is encrypted/i.test(String((e as { message?: unknown })?.message ?? ""));

export async function openForEdit(input: Uint8Array, name = "file.pdf"): Promise<Opened> {
  let bytes = input;
  let decrypted = false;
  try {
    const { output } = await runQpdf(input, (i, o) => ["--decrypt", "--decode-level=none", i, o]);
    decrypted = hasEncrypt(input);
    bytes = output;
  } catch (e) {
    // It needs an open password: nothing else will open it either.
    if (e instanceof QpdfError && e.wrongPassword) throw new PdfError("encrypted", name, e);
  }
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(bytes, { updateMetadata: false });
  } catch (e) {
    throw isEncrypted(e) ? new PdfError("encrypted", name, e) : toPdfError(e, name, input.subarray(0, 1024));
  }
  let count: number;
  try {
    count = doc.getPageCount();
  } catch (e) {
    // A page tree that loops back on itself.
    throw toPdfError(e, name, input.subarray(0, 1024));
  }
  if (!count) throw new PdfError("no_pages", name);
  return { doc, bytes, decrypted };
}

// A trailer names an encryption dictionary. Trailers (or the dictionaries of
// cross-reference streams, which are never compressed) sit at the end, and
// in a linearized file also near the start.
function hasEncrypt(bytes: Uint8Array) {
  const latin1 = (a: number, b: number) => new TextDecoder("latin1").decode(bytes.subarray(a, b));
  const span = 65536;
  return /\/Encrypt[\s/<\d]/.test(latin1(Math.max(0, bytes.length - span), bytes.length) + latin1(0, Math.min(span, bytes.length)));
}

// The rotation readers show: a multiple of 90 from 0 to 270. A /Rotate that
// isn't a multiple of 90 is invalid, and readers show such a page upright.
export function shownRotation(page: PDFPage) {
  const angle = page.getRotation().angle;
  return angle % 90 ? 0 : ((angle % 360) + 360) % 360;
}

// A copy pdf-lib wrote, for engines that can't read the original: its own
// cross-reference table, and every page directly under one page tree node (a
// tree thousands of levels deep overflows qpdf's stack). Inherited size,
// resources and rotation move onto the pages. An encrypted file stays
// encrypted: objects keep their numbers, which the encryption is keyed on.
export async function rebuilt(bytes: Uint8Array): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false, ignoreEncryption: true, throwOnInvalidObject: false });
  const ctx = doc.context;
  const pages = doc.getPages();
  const root = ctx.nextRef();
  for (const page of pages) {
    for (const key of PDFPageLeaf.InheritableEntries) {
      const value = page.node.getInheritableAttribute(PDFName.of(key));
      if (!page.node.get(PDFName.of(key)) && value) page.node.set(PDFName.of(key), value);
    }
    page.node.set(PDFName.of("Parent"), root);
  }
  const kids: PDFRef[] = pages.map((p) => p.ref);
  ctx.assign(root, ctx.obj({ Type: "Pages", Kids: PDFArray.withContext(ctx), Count: PDFNumber.of(kids.length) } as never));
  const node = ctx.lookup(root, PDFDict);
  node.set(PDFName.of("Kids"), ctx.obj(kids));
  doc.catalog.set(PDFName.of("Pages"), root);
  return doc.save({ useObjectStreams: false, addDefaultPage: false, updateFieldAppearances: false });
}
