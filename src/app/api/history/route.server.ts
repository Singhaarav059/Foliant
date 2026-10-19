import { getDb } from "@/lib/server/db";
import { currentUser } from "@/lib/server/auth";
import { error, failure, json, readJson, sameOrigin } from "@/lib/server/http";
import { TOOLS } from "@/lib/tools";

// Only the tool and file names are kept, never file contents.
export async function GET() {
  const user = await currentUser();
  if (!user) return json({ items: [] });
  const items = getDb()
    .prepare("SELECT tool, file_name AS fileName, created_at AS createdAt FROM history WHERE user_id = ? ORDER BY created_at DESC LIMIT 50")
    .all(user.id);
  return json({ items });
}

export async function POST(req: Request) {
  if (!sameOrigin(req)) return error("Forbidden", 403);
  const user = await currentUser();
  if (!user) return json({ ok: false });
  try {
    const { tool, fileName } = await readJson(req);
    if (!TOOLS.some((t) => t.id === tool)) return error("Unknown tool");
    const db = getDb();
    db.prepare("INSERT INTO history (user_id, tool, file_name, created_at) VALUES (?, ?, ?, ?)").run(user.id, String(tool), String(fileName ?? "").slice(0, 200), Date.now());
    db.prepare("DELETE FROM history WHERE user_id = ? AND id NOT IN (SELECT id FROM history WHERE user_id = ? ORDER BY created_at DESC LIMIT 200)").run(user.id, user.id);
    return json({ ok: true });
  } catch (e) {
    return failure(e, "Couldn't save the history entry.");
  }
}

export async function DELETE(req: Request) {
  if (!sameOrigin(req)) return error("Forbidden", 403);
  const user = await currentUser();
  if (!user) return error("Not signed in", 401);
  getDb().prepare("DELETE FROM history WHERE user_id = ?").run(user.id);
  return json({ ok: true });
}
