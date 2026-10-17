import type { Metadata } from "next";
import { LanguagePicker, PickerDocument } from "@/components/LanguagePicker";
import { BRAND } from "@/lib/brand";

// Static build only (experimental.globalNotFound in next.config.ts): written
// to out/404.html, which hosts such as GitHub Pages serve for every missing
// path. It is the language picker, so links without a language prefix still
// land, but unlike "/" it names no canonical address or translations, here
// and in the data React hydrates from. Next marks it noindex itself.
export const metadata: Metadata = {
  title: BRAND.name,
  icons: { icon: [{ url: "/favicon.ico", sizes: "48x48" }, { url: "/icon.svg", type: "image/svg+xml" }], apple: "/apple-touch-icon.png" },
};

export default function GlobalNotFound() {
  return (
    <PickerDocument>
      <LanguagePicker />
    </PickerDocument>
  );
}
