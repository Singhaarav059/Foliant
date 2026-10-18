import { getDb } from "@/lib/server/db";
import { currentUser } from "@/lib/server/auth";
import { error, failure, json, readJson, sameOrigin } from "@/lib/server/http";
import { TOOLS } from "@/lib/tools";

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
  try {
    const { name, steps } = (await readJson(req)) as { name?: string; steps?: Step[] };
    if (!Array.isArray(steps) || !steps.length || steps.length > 12) return error("Add between 1 and 12 steps.");
    if (steps.some((s) => !s || typeof s !== "object" || !chainable.has(s.tool))) return error("A step uses a tool that can't be chained.");
    // Passwords never leave the browser, so they're stripped before saving.
    const options = (o: unknown) => (o && typeof o === "object" && !Array.isArray(o) ? Object.entries(o) : []);
    const clean = steps.map((s) => ({ tool: s.tool, options: Object.fromEntries(options(s.options).filter(([k]) => !/password/i.test(k))) }));
    const count = (getDb().prepare("SELECT COUNT(*) AS n FROM workflows WHERE user_id = ?").get(user.id) as { n: number }).n;
    if (count >= 50) return error("You've reached the limit of 50 saved workflows.", 403);
    const info = getDb()
      .prepare("INSERT INTO workflows (user_id, name, steps, created_at) VALUES (?, ?, ?, ?)")
      .run(user.id, String(name || "Workflow").slice(0, 80), JSON.stringify(clean), Date.now());
    return json({ id: Number(info.lastInsertRowid) });
  } catch (e) {
    return failure(e, "Couldn't save the workflow. Try again.");
  }
}
