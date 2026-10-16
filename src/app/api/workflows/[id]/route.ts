import { getDb } from "@/lib/server/db";
import { currentUser, error, json, sameOrigin } from "@/lib/server/auth";

export async function DELETE(req: Request, ctx: RouteContext<"/api/workflows/[id]">) {
  if (!sameOrigin(req)) return error("Forbidden", 403);
  const user = await currentUser();
  if (!user) return error("Not signed in", 401);
  const { id } = await ctx.params;
  getDb().prepare("DELETE FROM workflows WHERE id = ? AND user_id = ?").run(Number(id), user.id);
  return json({ ok: true });
}
