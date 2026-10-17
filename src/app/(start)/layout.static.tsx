import type { Metadata } from "next";
import { PickerDocument } from "@/components/LanguagePicker";
import { BRAND, SITE_URL } from "@/lib/brand";
import { pageMetadata } from "@/lib/seo";

// Static build only (see next.config.ts): the bare "/" page, which has no
// language yet, so it sits outside the [lang] layout. It is the x-default
// every home page points to for visitors whose language isn't listed.
export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: BRAND.name,
  description: BRAND.tagline,
  icons: { icon: [{ url: "/favicon.ico", sizes: "48x48" }, { url: "/icon.svg", type: "image/svg+xml" }], apple: "/apple-touch-icon.png" },
  ...pageMetadata({ title: BRAND.name, description: BRAND.tagline }),
};

export default function StartLayout({ children }: { children: React.ReactNode }) {
  return <PickerDocument>{children}</PickerDocument>;
}
