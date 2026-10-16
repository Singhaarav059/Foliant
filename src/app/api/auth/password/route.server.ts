import bcrypt from "bcryptjs";
import { getDb } from "@/lib/server/db";
import { currentUser, error, json, sameOrigin } from "@/lib/server/auth";

export async function POST(req: Request) {
  if (!sameOrigin(req)) return error("Forbidden", 403);
  const user = await currentUser();
  if (!user) return error("Not signed in", 401);
  const { current, next } = (await req.json()) as { current?: string; next?: string };
  if (!(await bcrypt.compare(String(current ?? ""), user.pass_hash))) return error("bad_login", 401);
  if (String(next ?? "").length < 8) return error("weak");
  getDb().prepare("UPDATE users SET pass_hash = ? WHERE id = ?").run(await bcrypt.hash(String(next), 12), user.id);
  return json({ ok: true });
}
