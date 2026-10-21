// Landing pages for what people search for, like "compress PDF to 100 KB":
// a tool opened with its options already set, and text about that one job.
// Served at /{lang}/{slug} in every language, beside the tools.
import type { ToolId } from "./tools";

export type Intent = { slug: string; tool: ToolId; kb: number; preset: Record<string, unknown> };

export const INTENTS: Intent[] = [100, 200, 500].map((kb) => ({
  slug: `compress-pdf-to-${kb}kb`,
  tool: "compress",
  kb,
  preset: { targetKb: String(kb) },
}));

export const intentBySlug = (slug: string) => INTENTS.find((i) => i.slug === slug);
