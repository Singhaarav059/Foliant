import bcrypt from "bcryptjs";
import { getDb, publicUser, type UserRow } from "@/lib/server/db";
import { error, json, sameOrigin, startSession } from "@/lib/server/auth";
import { clientIp, rateLimit } from "@/lib/server/limits";

export async function POST(req: Request) {
  if (!sameOrigin(req)) return error("Forbidden", 403);
  if (!rateLimit(`register:${clientIp(req)}`, 10, 60 * 60 * 1000)) return error("Too many attempts. Try later.", 429);
  const { email, password, name } = (await req.json()) as { email?: string; password?: string; name?: string };
  const mail = String(email ?? "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail) || mail.length > 254) return error("invalid_email");
  if (String(password ?? "").length < 8 || String(password).length > 200) return error("weak");
  const db = getDb();
  if (db.prepare("SELECT 1 FROM users WHERE email = ?").get(mail)) return error("taken", 409);
  const hash = await bcrypt.hash(String(password), 12);
  const info = db
    .prepare("INSERT INTO users (email, name, pass_hash, created_at) VALUES (?, ?, ?, ?)")
    .run(mail, String(name ?? "").trim().slice(0, 80), hash, Date.now());
  const row = db.prepare("SELECT * FROM users WHERE id = ?").get(Number(info.lastInsertRowid)) as UserRow;
  await startSession(row.id);
  return json({ user: publicUser(row) });
}
