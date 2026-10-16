import bcrypt from "bcryptjs";
import { getDb, publicUser, type UserRow } from "@/lib/server/db";
import { error, json, sameOrigin, startSession } from "@/lib/server/auth";
import { clientIp, rateLimit } from "@/lib/server/limits";

// Compared against when the email is unknown, so timing doesn't reveal which emails exist.
let dummy: Promise<string> | undefined;
const dummyHash = () => (dummy ??= bcrypt.hash("not-a-real-password", 12));

export async function POST(req: Request) {
  if (!sameOrigin(req)) return error("Forbidden", 403);
  if (!rateLimit(`login:${clientIp(req)}`, 20, 15 * 60 * 1000)) return error("Too many attempts. Try later.", 429);
  const { email, password } = (await req.json()) as { email?: string; password?: string };
  const row = getDb().prepare("SELECT * FROM users WHERE email = ?").get(String(email ?? "").trim().toLowerCase()) as UserRow | undefined;
  const ok = await bcrypt.compare(String(password ?? ""), row?.pass_hash ?? (await dummyHash()));
  if (!row || !ok) return error("bad_login", 401);
  await startSession(row.id);
  return json({ user: publicUser(row) });
}
