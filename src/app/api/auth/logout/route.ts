import { endSession, json, sameOrigin, error } from "@/lib/server/auth";

export async function POST(req: Request) {
  if (!sameOrigin(req)) return error("Forbidden", 403);
  await endSession();
  return json({ ok: true });
}
