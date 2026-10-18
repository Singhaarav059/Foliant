import { sitemapXml } from "@/lib/seo";

// Static build: written to out/sitemap.xml. output: "export" only writes routes
// marked static; the server build has route.server.ts, without the marker,
// which Cache Components rule out.
export const dynamic = "force-static";

export function GET() {
  return new Response(sitemapXml(), { headers: { "Content-Type": "application/xml; charset=utf-8" } });
}
