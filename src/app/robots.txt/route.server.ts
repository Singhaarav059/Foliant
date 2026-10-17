import { robotsTxt } from "@/lib/seo";

// Server build; the static build has route.static.tsx.
export function GET() {
  return new Response(robotsTxt(), { headers: { "Content-Type": "text/plain; charset=utf-8" } });
}
