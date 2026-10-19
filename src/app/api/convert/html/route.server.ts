import { printToPdf } from "@/lib/server/chrome";
import { error, failure, HttpError, matchesType, sameOrigin } from "@/lib/server/http";
import { clientIp, MAX_HTML_BYTES, rateLimit, readForm } from "@/lib/server/limits";
import { resolvePublic } from "@/lib/server/net";

export const maxDuration = 120;

const unreachable = () => new HttpError(400, "That address isn't reachable from the public internet.");

// The address typed in the form. Anything with a scheme other than http(s)
// (file:, gopher:, ...) is refused; a bare "example.com" gets https://.
function parseUrl(raw: string) {
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(raw)?.[1];
  if (scheme && !/^https?$/i.test(scheme) && !scheme.includes(".")) throw new HttpError(400, "Only http and https addresses work.");
  try {
    return new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    throw new HttpError(400, "Enter a valid web address.");
  }
}

export async function POST(req: Request) {
  if (!sameOrigin(req)) return error("Forbidden", 403);
  if (!rateLimit(`html:${clientIp(req)}`, 30, 10 * 60 * 1000)) return error("Too many conversions. Wait a few minutes.", 429);
  try {
    const form = await readForm(req, MAX_HTML_BYTES + 64 * 1024);
    const file = form.get("file");
    const opts = {
      pageSize: ["a4", "letter", "single"].includes(String(form.get("pageSize"))) ? String(form.get("pageSize")) : "a4",
      orientation: String(form.get("orientation")) === "landscape" ? "landscape" : "portrait",
      screenWidth: [1440, 1024, 390].includes(Number(form.get("screenWidth"))) ? Number(form.get("screenWidth")) : 1440,
      hideOverlays: String(form.get("hideOverlays")) !== "false",
    };
    let pdf: Uint8Array;
    if (file instanceof File) {
      if (file.size > MAX_HTML_BYTES) return error("File too large.", 413);
      const data = new Uint8Array(await file.arrayBuffer());
      if (!matchesType(data, "html")) return error("Unsupported file type.", 415);
      pdf = await printToPdf({ html: new TextDecoder().decode(data) }, opts);
    } else {
      const url = parseUrl(String(form.get("url") ?? "").trim());
      if (!/^https?:$/.test(url.protocol)) return error("Only http and https addresses work.");
      // A friendly early answer; the egress proxy enforces it for every request the page makes.
      if (!(await resolvePublic(url.hostname))) throw unreachable();
      pdf = await printToPdf({ url: url.toString() }, opts);
    }
    return new Response(pdf as BodyInit, { headers: { "Content-Type": "application/pdf", "Cache-Control": "no-store" } });
  } catch (e) {
    const msg = e instanceof HttpError ? "" : e instanceof Error ? e.message : "";
    if (/Timeout/i.test(msg)) return error("The page took too long to load.", 504);
    if (/ERR_TUNNEL_CONNECTION_FAILED|ERR_BLOCKED_BY_CLIENT/i.test(msg)) return failure(unreachable(), "");
    if (/ERR_NAME_NOT_RESOLVED|ERR_CONNECTION|ERR_ADDRESS/i.test(msg)) return error("Couldn't reach that address.", 502);
    return failure(e, "Couldn't convert that page.");
  }
}
