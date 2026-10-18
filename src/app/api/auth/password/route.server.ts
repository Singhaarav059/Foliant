import bcrypt from "bcryptjs";
import { getDb } from "@/lib/server/db";
import { currentUser, restartSessions } from "@/lib/server/auth";
import { error, failure, json, readJson, sameOrigin } from "@/lib/server/http";
import { rateLimit } from "@/lib/server/limits";

export async function POST(req: Request) {
  if (!sameOrigin(req)) return error("Forbidden", 403);
  const user = await currentUser();
  if (!user) return error("Not signed in", 401);
  // A stolen session can't be used to guess the current password.
  if (!rateLimit(`password:${user.id}`, 10, 15 * 60 * 1000)) return error("Too many attempts. Try later.", 429);
  try {
    const { current, next } = await readJson(req);
    if (!(await bcrypt.compare(String(current ?? "").slice(0, 200), user.pass_hash))) return error("bad_login", 401);
    if (String(next ?? "").length < 8 || String(next).length > 200) return error("weak");
    getDb().prepare("UPDATE users SET pass_hash = ? WHERE id = ?").run(await bcrypt.hash(String(next), 12), user.id);
    // Every other session ends; this browser gets a new token.
    await restartSessions(user);
    return json({ ok: true });
  } catch (e) {
    return failure(e, "Couldn't change the password. Try again.");
  }
}
