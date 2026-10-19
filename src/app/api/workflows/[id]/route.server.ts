import { getDb } from "@/lib/server/db";
import { currentUser } from "@/lib/server/auth";
import { error, json, sameOrigin } from "@/lib/server/http";

// Typed by hand: the generated RouteContext type is missing from static builds,
// which leave this file out.
export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!sameOrigin(req)) return error("Forbidden", 403);
  const user = await currentUser();
  if (!user) return error("Not signed in", 401);
  const { id } = await ctx.params;
  getDb().prepare("DELETE FROM workflows WHERE id = ? AND user_id = ?").run(Number(id), user.id);
  return json({ ok: true });
}
