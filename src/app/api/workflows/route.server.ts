import { getDb } from "@/lib/server/db";
import { currentUser, error, json, sameOrigin } from "@/lib/server/auth";
import { TOOLS } from "@/lib/tools";
import { withoutSecrets } from "@/lib/pdf/password";

type Step = { tool: string; options: Record<string, unknown> };

const chainable = new Set(TOOLS.filter((t) => t.chainable).map((t) => t.id as string));

export async function GET() {
  const user = await currentUser();
  if (!user) return json({ workflows: [] });
  const rows = getDb().prepare("SELECT id, name, steps, created_at FROM workflows WHERE user_id = ? ORDER BY created_at DESC").all(user.id) as {
    id: number; name: string; steps: string; created_at: number;
  }[];
  return json({ workflows: rows.map((r) => ({ id: r.id, name: r.name, steps: JSON.parse(r.steps), createdAt: r.created_at })) });
}

export async function POST(req: Request) {
  if (!sameOrigin(req)) return error("Forbidden", 403);
  const user = await currentUser();
  if (!user) return error("Not signed in", 401);
  const { name, steps } = (await req.json()) as { name?: string; steps?: Step[] };
  if (!Array.isArray(steps) || !steps.length || steps.length > 12) return error("Add between 1 and 12 steps.");
  if (steps.some((s) => !chainable.has(s.tool))) return error("A step uses a tool that can't be chained.");
  // Passwords never leave the browser, so they're stripped before saving.
  const clean = steps.map((s) => ({ tool: s.tool, options: withoutSecrets(s.options ?? {}) }));
  const count = (getDb().prepare("SELECT COUNT(*) AS n FROM workflows WHERE user_id = ?").get(user.id) as { n: number }).n;
  if (count >= 50) return error("You've reached the limit of 50 saved workflows.", 403);
  const info = getDb()
    .prepare("INSERT INTO workflows (user_id, name, steps, created_at) VALUES (?, ?, ?, ?)")
    .run(user.id, String(name || "Workflow").slice(0, 80), JSON.stringify(clean), Date.now());
  return json({ id: Number(info.lastInsertRowid) });
}
