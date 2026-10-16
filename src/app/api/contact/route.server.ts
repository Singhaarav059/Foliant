import { getDb } from "@/lib/server/db";
import { error, json, sameOrigin } from "@/lib/server/auth";
import { clientIp, rateLimit } from "@/lib/server/limits";

// Messages are stored for the site owner to read; nothing is emailed from here.
export async function POST(req: Request) {
  if (!sameOrigin(req)) return error("Forbidden", 403);
  if (!rateLimit(`contact:${clientIp(req)}`, 5, 60 * 60 * 1000)) return error("Too many messages. Try later.", 429);
  const { email, message } = (await req.json()) as { email?: string; message?: string };
  const mail = String(email ?? "").trim();
  const body = String(message ?? "").trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) return error("invalid_email");
  if (body.length < 5 || body.length > 5000) return error("Message must be 5 to 5000 characters.");
  getDb().prepare("INSERT INTO messages (email, body, created_at) VALUES (?, ?, ?)").run(mail, body, Date.now());
  return json({ ok: true });
}
