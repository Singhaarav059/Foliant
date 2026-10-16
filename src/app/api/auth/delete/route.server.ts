import bcrypt from "bcryptjs";
import { getDb } from "@/lib/server/db";
import { currentUser, endSession, error, json, sameOrigin } from "@/lib/server/auth";

export async function POST(req: Request) {
  if (!sameOrigin(req)) return error("Forbidden", 403);
  const user = await currentUser();
  if (!user) return error("Not signed in", 401);
  const { password } = (await req.json()) as { password?: string };
  if (!(await bcrypt.compare(String(password ?? ""), user.pass_hash))) return error("bad_login", 401);
  getDb().prepare("DELETE FROM users WHERE id = ?").run(user.id); // workflows and history cascade
  await endSession();
  return json({ ok: true });
}
