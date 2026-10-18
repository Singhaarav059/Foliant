import bcrypt from "bcryptjs";
import { getDb } from "@/lib/server/db";
import { currentUser, endSession } from "@/lib/server/auth";
import { error, failure, json, readJson, sameOrigin } from "@/lib/server/http";
import { rateLimit } from "@/lib/server/limits";

export async function POST(req: Request) {
  if (!sameOrigin(req)) return error("Forbidden", 403);
  const user = await currentUser();
  if (!user) return error("Not signed in", 401);
  if (!rateLimit(`delete:${user.id}`, 10, 15 * 60 * 1000)) return error("Too many attempts. Try later.", 429);
  try {
    const { password } = await readJson(req);
    if (!(await bcrypt.compare(String(password ?? "").slice(0, 200), user.pass_hash))) return error("bad_login", 401);
    await endSession();
    getDb().prepare("DELETE FROM users WHERE id = ?").run(user.id); // workflows and history cascade
    return json({ ok: true });
  } catch (e) {
    return failure(e, "Couldn't delete the account. Try again.");
  }
}
