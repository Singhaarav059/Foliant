import { printToPdf, publicHost } from "@/lib/server/chrome";
import { error } from "@/lib/server/auth";
import { clientIp, MAX_UPLOAD_BYTES, rateLimit } from "@/lib/server/limits";

export const maxDuration = 120;

export async function POST(req: Request) {
  if (!rateLimit(`html:${clientIp(req)}`, 30, 10 * 60 * 1000)) return error("Too many conversions. Wait a few minutes.", 429);
  const form = await req.formData();
  const file = form.get("file");
  const opts = {
    pageSize: ["a4", "letter", "single"].includes(String(form.get("pageSize"))) ? String(form.get("pageSize")) : "a4",
    orientation: String(form.get("orientation")) === "landscape" ? "landscape" : "portrait",
    screenWidth: [1440, 1024, 390].includes(Number(form.get("screenWidth"))) ? Number(form.get("screenWidth")) : 1440,
    hideOverlays: String(form.get("hideOverlays")) !== "false",
  };
  try {
    if (file instanceof File) {
      if (file.size > MAX_UPLOAD_BYTES) return error("File too large.", 413);
      const pdf = await printToPdf({ html: await file.text() }, opts);
      return new Response(pdf as BodyInit, { headers: { "Content-Type": "application/pdf", "Cache-Control": "no-store" } });
    }
    let url: URL;
    try {
      const raw = String(form.get("url") ?? "").trim();
      url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    } catch {
      return error("Enter a valid web address.");
    }
    if (!/^https?:$/.test(url.protocol)) return error("Only http and https addresses work.");
    if (!(await publicHost(url.hostname))) return error("That address isn't reachable from the public internet.");
    const pdf = await printToPdf({ url: url.toString() }, opts);
    return new Response(pdf as BodyInit, { headers: { "Content-Type": "application/pdf", "Cache-Control": "no-store" } });
  } catch (e) {
    console.error("[html]", e);
    const msg = e instanceof Error ? e.message : "";
    if (/Timeout/i.test(msg)) return error("The page took too long to load.", 504);
    if (/ERR_NAME_NOT_RESOLVED|ERR_CONNECTION/i.test(msg)) return error("Couldn't reach that address.", 502);
    return error(msg.includes("Chrome") ? msg : "Couldn't convert that page.", 500);
  }
}
