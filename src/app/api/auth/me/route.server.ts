import { currentPublicUser } from "@/lib/server/auth";

export async function GET() {
  return Response.json({ user: await currentPublicUser() }, { headers: { "Cache-Control": "no-store" } });
}
