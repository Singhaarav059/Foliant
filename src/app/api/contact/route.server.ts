import { getDb } from "@/lib/server/db";
import { error, failure, json, readJson, sameOrigin } from "@/lib/server/http";
import { clientIp, rateLimit } from "@/lib/server/limits";

// Messages are stored for the site owner to read; nothing is emailed from here.
export async function POST(req: Request) {
  if (!sameOrigin(req)) return error("Forbidden", 403);
  if (!rateLimit(`contact:${clientIp(req)}`, 5, 60 * 60 * 1000)) return error("Too many messages. Try later.", 429);
  try {
    const { email, message } = await readJson(req);
    const mail = String(email ?? "").trim();
    const body = String(message ?? "").trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail) || mail.length > 254) return error("invalid_email");
    if (body.length < 5 || body.length > 5000) return error("Message must be 5 to 5000 characters.");
    getDb().prepare("INSERT INTO messages (email, body, created_at) VALUES (?, ?, ?)").run(mail, body, Date.now());
    return json({ ok: true });
  } catch (e) {
    return failure(e, "Couldn't send the message. Try again.");
  }
}
