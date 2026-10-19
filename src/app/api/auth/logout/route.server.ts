import { endSession } from "@/lib/server/auth";
import { error, json, sameOrigin } from "@/lib/server/http";

export async function POST(req: Request) {
  if (!sameOrigin(req)) return error("Forbidden", 403);
  await endSession();
  return json({ ok: true });
}
