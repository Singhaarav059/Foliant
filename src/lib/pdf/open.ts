"use client";

// Opens a PDF for editing the way readers open it. pdf-lib reads a file from
// top to bottom, so where an object number is defined twice it takes the
// last copy, while readers follow the cross-reference table; it refuses any
// encrypted file, even one with only an owner password, which every viewer
// opens without asking. So the file first goes through qpdf, which follows
// the table, decrypts with the empty password when that is all it takes, and
// leaves out what nothing refers to. Streams stay as they are stored (nothing
// is inflated). When qpdf can't read the file (damage it doesn't repair, or
// no qpdf at all, offline), pdf-lib reads the original bytes. A big file
// that pdf-lib alone reads as readers do skips qpdf (see readDirect).
import {
  PDFArray, PDFContext, PDFDict, PDFDocument, PDFInvalidObject, PDFName, PDFNumber, PDFPage, PDFPageLeaf, PDFParser, PDFRef,
} from "pdf-lib";
import { PdfError, toPdfError } from "./errors";
import { hasEncrypt } from "./password";
import { QpdfError, runQpdf } from "./qpdf";

export type Opened = {
  doc: PDFDocument;
  // The bytes `doc` was read from: what readers show, decrypted.
  bytes: Uint8Array;
  // The file had an owner password (restrictions), which the copy no longer has.
  decrypted: boolean;
};

const isEncrypted = (e: unknown) => /is encrypted/i.test(String((e as { message?: unknown })?.message ?? ""));

// qpdf rewrites the whole file, which for a few hundred megabytes takes
// seconds and a second copy in memory. A big file that pdf-lib reads exactly
// as readers do skips it (tests lower the threshold).
export const directOpen = { minBytes: 20 * 1024 * 1024 };

export async function openForEdit(input: Uint8Array, name = "file.pdf"): Promise<Opened> {
  let bytes = input;
  let decrypted = false;
  let doc = input.length >= directOpen.minBytes ? await readDirect(input) : null;
  if (!doc) {
    try {
      const { output } = await runQpdf(input, (i, o) => ["--decrypt", "--decode-level=none", i, o]);
      decrypted = hasEncrypt(input);
      bytes = output;
    } catch (e) {
      // It needs an open password: nothing else will open it either.
      if (e instanceof QpdfError && e.wrongPassword) throw new PdfError("encrypted", name, e);
    }
    try {
      doc = await PDFDocument.load(bytes, { updateMetadata: false });
    } catch (e) {
      throw isEncrypted(e) ? new PdfError("encrypted", name, e) : toPdfError(e, name, input.subarray(0, 1024));
    }
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

// pdf-lib reads every object in file order, so it reads the file as
// readers do when the file defines each object once (in place or in an
// object stream), isn't encrypted and has nothing pdf-lib had to guess at.
// Returns null when any of that fails.
async function readDirect(bytes: Uint8Array): Promise<PDFDocument | null> {
  try {
    // 100 objects a tick, as PDFDocument.load parses by default.
    const parser = PDFParser.forBytesWithOptions(bytes, 100);
    const ctx = (parser as unknown as { context: PDFContext }).context;
    let plain = true;
    const assign = ctx.assign;
    ctx.assign = (ref, object) => {
      if (ctx.lookup(ref) !== undefined || object instanceof PDFInvalidObject) plain = false;
      assign.call(ctx, ref, object);
    };
    await parser.parseDocument();
    delete (ctx as { assign?: unknown }).assign;
    if (!plain || ctx.trailerInfo.Encrypt) return null;
    // What PDFDocument.load does with the parsed context.
    return new (PDFDocument as unknown as new (c: PDFContext, ignoreEncryption: boolean, updateMetadata: boolean) => PDFDocument)(ctx, false, false);
  } catch {
    return null;
  }
}

// A trailer names an encryption dictionary. Trailers (or the dictionaries of
// cross-reference streams, which are never compressed) sit at the end, and
// in a linearized file also near the start.

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
