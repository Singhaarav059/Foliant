import "server-only";
import { HttpError } from "./errors";
import { MAX_JSON_BYTES, readBody } from "./limits";

export { HttpError };

export const json = (data: unknown, status = 200) => Response.json(data, { status });
export const error = (message: string, status = 400) => Response.json({ error: message }, { status });

// State-changing requests must come from this site. Browsers send
// Sec-Fetch-Site on every request (and it survives a proxy rewriting Host);
// older ones send Origin on cross-site POSTs. A request with neither isn't
// from a browser, so it can't carry a victim's cookies by accident.
export function sameOrigin(req: Request) {
  const site = req.headers.get("sec-fetch-site");
  if (site) return site === "same-origin";
  const origin = req.headers.get("origin");
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.get("host");
  } catch {
    return false;
  }
}

// A JSON object body. Requiring application/json also stops cross-site
// <form enctype="text/plain"> posts, which can't set it without a preflight.
export async function readJson(req: Request, max = MAX_JSON_BYTES): Promise<Record<string, unknown>> {
  if (!/^application\/json\s*(;|$)/i.test(req.headers.get("content-type") ?? "")) throw new HttpError(415, "Send JSON.");
  const body = await readBody(req, max);
  let data: unknown;
  try {
    data = JSON.parse(new TextDecoder().decode(body));
  } catch {
    throw new HttpError(400, "That request couldn't be read.");
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new HttpError(400, "That request couldn't be read.");
  return data as Record<string, unknown>;
}

const ZIP = [0x50, 0x4b, 0x03, 0x04];
const OLE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const startsWith = (b: Uint8Array, magic: number[]) => magic.every((x, i) => b[i] === x);
const isText = (b: Uint8Array) => !b.subarray(0, 64 * 1024).includes(0);

// Converters pick a parser from a file's content, not its name, so an upload
// must actually be what its extension says.
export function matchesType(bytes: Uint8Array, ext: string) {
  switch (ext) {
    case "docx": case "xlsx": case "pptx": case "odt": case "ods": case "odp":
      return startsWith(bytes, ZIP);
    case "doc": case "xls": case "ppt":
      return startsWith(bytes, OLE);
    case "rtf":
      return new TextDecoder().decode(bytes.subarray(0, 5)) === "{\\rtf";
    case "csv": case "html": case "htm":
      return isText(bytes) && !startsWith(bytes, ZIP) && !startsWith(bytes, OLE);
    default:
      return false;
  }
}

// The response for a failed request: a deliberate HttpError as it is,
// anything else logged here and answered with `fallback`, so paths, commands
// and library internals never reach the client.
export function failure(e: unknown, fallback: string) {
  if (e instanceof HttpError) return error(e.message, e.status);
  console.error("[server]", e);
  return error(fallback, 500);
}
