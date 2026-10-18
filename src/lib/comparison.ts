// Other PDF sites' free tiers, for the home page's comparison. Owner's rule:
// name a competitor only with accurate, dated, sourced free-tier facts, in a
// neutral tone, and use none of their assets. Every figure below was read
// from the linked public page on the date given; the wording is in en.ts
// ("cmp.*"). Check the source again before changing a figure or its date.
//
// iLovePDF: docs/plan.md section 1, observed 2026-10-17 (and unchanged on
// 2026-10-18). Each tool page loads its limits as settings; these are the
// free ones ("registered_limits"). The site sometimes raises them for a
// while for new visitors ("temp_limits"), which the table's note says.
import type { ToolId } from "@/lib/tools";

export type Limit =
  | { kind: "mbFiles"; mb: number; files: number }
  | { kind: "mbFilesPages"; mb: number; files: number; pages: number }
  | { kind: "pagesMbHour"; pages: number; mb: number; tasks: number }
  | { kind: "dailyDownloads" }
  | { kind: "noLimitsAds" };

/** Where the service says files are processed: "servers", with how long it says it keeps them when it does. */
export type Where = { kind: "servers"; hours?: number } | { kind: "notChecked" };

export type Competitor = { service: string; tool: ToolId | null; limit: Limit; where: Where; source: string; checked: string };

export const COMPARISON: Competitor[] = [
  { service: "iLovePDF", tool: "merge", limit: { kind: "mbFiles", mb: 100, files: 25 }, where: { kind: "servers" }, source: "https://www.ilovepdf.com/merge_pdf", checked: "2026-10-17" },
  { service: "iLovePDF", tool: "compress", limit: { kind: "mbFiles", mb: 200, files: 2 }, where: { kind: "servers" }, source: "https://www.ilovepdf.com/compress_pdf", checked: "2026-10-17" },
  { service: "iLovePDF", tool: "ocr", limit: { kind: "mbFilesPages", mb: 15, files: 1, pages: 50 }, where: { kind: "servers" }, source: "https://www.ilovepdf.com/ocr-pdf", checked: "2026-10-17" },
  { service: "iLovePDF", tool: "wordToPdf", limit: { kind: "mbFiles", mb: 15, files: 1 }, where: { kind: "servers" }, source: "https://www.ilovepdf.com/word_to_pdf", checked: "2026-10-17" },
  { service: "iLovePDF", tool: "jpgToPdf", limit: { kind: "mbFiles", mb: 40, files: 20 }, where: { kind: "servers" }, source: "https://www.ilovepdf.com/jpg_to_pdf", checked: "2026-10-17" },
  { service: "iLovePDF", tool: "sign", limit: { kind: "mbFiles", mb: 50, files: 3 }, where: { kind: "servers" }, source: "https://www.ilovepdf.com/sign-pdf", checked: "2026-10-17" },
  // "Free service for documents up to 200 pages or 100 MB and 3 tasks per
  // hour", and "Automatically deleted after 2 hours".
  { service: "Sejda", tool: "compress", limit: { kind: "pagesMbHour", pages: 200, mb: 100, tasks: 3 }, where: { kind: "servers", hours: 2 }, source: "https://www.sejda.com/compress-pdf", checked: "2026-10-18" },
  // The pricing page lists a "Daily download limit" for free use without a number.
  { service: "Smallpdf", tool: null, limit: { kind: "dailyDownloads" }, where: { kind: "notChecked" }, source: "https://smallpdf.com/pricing", checked: "2026-10-18" },
  // "No limits", "100% free thanks to advertising", "compressed in the cloud on our servers".
  { service: "PDF24", tool: "compress", limit: { kind: "noLimitsAds" }, where: { kind: "servers" }, source: "https://tools.pdf24.org/en/compress-pdf", checked: "2026-10-18" },
];
