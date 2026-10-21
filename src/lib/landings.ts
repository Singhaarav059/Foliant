// Landing pages for one exact job people search for, like "compress PDF to 100 KB":
// a tool opened with its options already set, and text about that one job.
// Served at /{lang}/{slug} in every language, beside the tools.
import type { ToolId } from "./tools";

export type Landing = { slug: string; tool: ToolId; kb: number; preset: Record<string, unknown> };

export const LANDINGS: Landing[] = [100, 200, 500].map((kb) => ({
  slug: `compress-pdf-to-${kb}kb`,
  tool: "compress",
  kb,
  preset: { targetKb: String(kb) },
}));

export const landingBySlug = (slug: string) => LANDINGS.find((i) => i.slug === slug);
