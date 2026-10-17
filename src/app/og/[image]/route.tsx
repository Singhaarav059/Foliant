import { ImageResponse } from "next/og";
import { BRAND, SITE_URL } from "@/lib/brand";
import en, { type DictKey } from "@/lib/i18n/dict/en";
import { OG_SIZE } from "@/lib/seo";
import { TOOLS } from "@/lib/tools";

// Social cards (og:image, twitter:image), drawn at build time: one per tool
// and "home" for every other page. Every language shares them, so the text
// is English. Colours are the light theme's (src/app/globals.css).
export function generateStaticParams() {
  return [...TOOLS.map((t) => ({ image: `${t.slug}.png` })), { image: "home.png" }];
}

export async function GET(_req: Request, { params }: RouteContext<"/og/[image]">) {
  const { image } = await params;
  const tool = TOOLS.find((t) => `${t.slug}.png` === image);
  if (!tool && image !== "home.png") return new Response("Not found", { status: 404 });
  const title = tool ? en[`tool.${tool.id}.name` as DictKey] : en["home.title"];
  const body = tool ? en[`tool.${tool.id}.desc` as DictKey] : en["home.subtitle"];
  const note = !tool ? BRAND.tagline : tool.runtime === "browser" ? en["home.privateBadge"] : en["home.serverBadge"];

  return new ImageResponse(
    (
      <div style={{ display: "flex", flexDirection: "column", width: "100%", height: "100%", padding: 72, background: "#f7f7f5", color: "#191917" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 16, fontSize: 40, letterSpacing: "-0.03em" }}>
          <svg width="48" height="48" viewBox="0 0 24 24">
            <path d="M5 3.5A1.5 1.5 0 0 1 6.5 2H15l5 5v13.5a1.5 1.5 0 0 1-1.5 1.5h-12A1.5 1.5 0 0 1 5 20.5z" fill="#191917" />
            <path d="M15 2v3.5A1.5 1.5 0 0 0 16.5 7H20z" fill="#cf4a24" />
          </svg>
          {BRAND.name}
        </div>
        <div style={{ display: "flex", flex: 1, alignItems: "center", gap: 64 }}>
          <div style={{ display: "flex", flexDirection: "column", flex: 1 }}>
            <div style={{ fontSize: tool ? 96 : 76, lineHeight: 1.04, letterSpacing: "-0.045em" }}>{title}</div>
            <div style={{ marginTop: 28, fontSize: tool ? 34 : 30, lineHeight: 1.4, color: "#4a4a45" }}>{body}</div>
          </div>
          {/* The logo's folio, large. */}
          <svg width="230" height="276" viewBox="5 2 15 20">
            <path d="M5 3.5A1.5 1.5 0 0 1 6.5 2H15l5 5v13.5a1.5 1.5 0 0 1-1.5 1.5h-12A1.5 1.5 0 0 1 5 20.5z" fill="#191917" />
            <path d="M15 2v3.5A1.5 1.5 0 0 0 16.5 7H20z" fill="#cf4a24" />
          </svg>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", borderTop: "2px solid #e6e6e1", paddingTop: 28, fontSize: 28, color: "#76766f" }}>
          <span>{note}</span>
          <span>{new URL(SITE_URL).host}</span>
        </div>
      </div>
    ),
    OG_SIZE,
  );
}
