import { officeToPdf, UnsupportedFormat } from "@/lib/server/office";
import { error } from "@/lib/server/auth";
import { clientIp, MAX_UPLOAD_BYTES, rateLimit } from "@/lib/server/limits";

export const maxDuration = 300;

const ALLOWED = new Set(["docx", "doc", "odt", "rtf", "pptx", "ppt", "odp", "xlsx", "xls", "ods", "csv"]);

// Files are converted in memory or a private temp folder and never kept.
export async function POST(req: Request) {
  if (!rateLimit(`office:${clientIp(req)}`, 60, 10 * 60 * 1000)) return error("Too many conversions. Wait a few minutes.", 429);
  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return error("Add a file.");
  if (file.size > MAX_UPLOAD_BYTES) return error("File too large.", 413);
  const ext = (file.name.split(".").pop() || "").toLowerCase();
  if (!ALLOWED.has(ext)) return error("Unsupported file type.", 415);
  try {
    const { pdf, engine } = await officeToPdf(new Uint8Array(await file.arrayBuffer()), ext, String(form.get("orientation") || "auto"));
    return new Response(pdf as BodyInit, {
      headers: { "Content-Type": "application/pdf", "Cache-Control": "no-store", "X-Engine": engine },
    });
  } catch (e) {
    if (e instanceof UnsupportedFormat) return error(e.message, 422);
    console.error("[office]", e);
    return error(e instanceof Error ? e.message : "Conversion failed.", 500);
  }
}
