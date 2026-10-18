import { sitemapXml } from "@/lib/seo";

// Server build; the static build has route.static.tsx.
export function GET() {
  return new Response(sitemapXml(), { headers: { "Content-Type": "application/xml; charset=utf-8" } });
}
