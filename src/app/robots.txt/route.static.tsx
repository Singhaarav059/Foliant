import { robotsTxt } from "@/lib/seo";

// Static build: written to out/robots.txt. output: "export" only writes routes
// marked static; the server build has route.server.ts, without the marker,
// which Cache Components rule out.
export const dynamic = "force-static";

export function GET() {
  return new Response(robotsTxt(), { headers: { "Content-Type": "text/plain; charset=utf-8" } });
}
