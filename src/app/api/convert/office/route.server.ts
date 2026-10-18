import { officeToPdf } from "@/lib/server/office";
import { error, failure, matchesType, sameOrigin } from "@/lib/server/http";
import { clientIp, MAX_UPLOAD_BYTES, rateLimit, readForm } from "@/lib/server/limits";

export const maxDuration = 300;

const ALLOWED = new Set(["docx", "doc", "odt", "rtf", "pptx", "ppt", "odp", "xlsx", "xls", "ods", "csv"]);

// Files are converted in memory or a private temp folder and never kept.
export async function POST(req: Request) {
  if (!sameOrigin(req)) return error("Forbidden", 403);
  if (!rateLimit(`office:${clientIp(req)}`, 60, 10 * 60 * 1000)) return error("Too many conversions. Wait a few minutes.", 429);
  try {
    const form = await readForm(req, MAX_UPLOAD_BYTES + 64 * 1024);
    const file = form.get("file");
    if (!(file instanceof File)) return error("Add a file.");
    if (file.size > MAX_UPLOAD_BYTES) return error("File too large.", 413);
    const ext = (file.name.split(".").pop() || "").toLowerCase();
    const data = new Uint8Array(await file.arrayBuffer());
    if (!ALLOWED.has(ext) || !matchesType(data, ext)) return error("Unsupported file type.", 415);
    const { pdf, engine } = await officeToPdf(data, ext, String(form.get("orientation") || "auto"));
    return new Response(pdf as BodyInit, {
      headers: { "Content-Type": "application/pdf", "Cache-Control": "no-store", "X-Engine": engine },
    });
  } catch (e) {
    return failure(e, "Couldn't convert that file.");
  }
}
