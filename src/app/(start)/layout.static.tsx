import type { Metadata } from "next";
import { BRAND } from "@/lib/brand";

// Static build only (see next.config.ts): the bare "/" page, which has no
// language yet, so it sits outside the [lang] layout.
export const metadata: Metadata = { title: BRAND.name, robots: { index: false } };

export default function StartLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, font: "16px/1.5 system-ui, sans-serif", background: "#f7f7f5", color: "#191917" }}>{children}</body>
    </html>
  );
}
