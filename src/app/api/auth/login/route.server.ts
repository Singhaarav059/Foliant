import bcrypt from "bcryptjs";
import { getDb, publicUser, type UserRow } from "@/lib/server/db";
import { startSession } from "@/lib/server/auth";
import { error, failure, json, readJson, sameOrigin } from "@/lib/server/http";
import { clearHits, clientIp, hitCount, rateLimit, recordHit } from "@/lib/server/limits";

const WINDOW = 15 * 60 * 1000;

// Compared against when the email is unknown, so timing doesn't reveal which emails exist.
let dummy: Promise<string> | undefined;
const dummyHash = () => (dummy ??= bcrypt.hash("not-a-real-password", 12));

export async function POST(req: Request) {
  if (!sameOrigin(req)) return error("Forbidden", 403);
  // 20 tries per address, and 10 failures per account from any number of
  // addresses, each per 15 minutes.
  if (!rateLimit(`login:${clientIp(req)}`, 20, WINDOW)) return error("Too many attempts. Try later.", 429);
  try {
    const { email, password } = await readJson(req);
    const mail = String(email ?? "").trim().toLowerCase().slice(0, 254);
    const account = `login-failed:${mail}`;
    if (hitCount(account, WINDOW) >= 10) return error("Too many attempts. Try later.", 429);
    const row = getDb().prepare("SELECT * FROM users WHERE email = ?").get(mail) as UserRow | undefined;
    const ok = await bcrypt.compare(String(password ?? "").slice(0, 200), row?.pass_hash ?? (await dummyHash()));
    if (!row || !ok) {
      recordHit(account, WINDOW);
      return error("bad_login", 401);
    }
    clearHits(account);
    await startSession(row);
    return json({ user: publicUser(row) });
  } catch (e) {
    return failure(e, "Couldn't sign in. Try again.");
  }
}
