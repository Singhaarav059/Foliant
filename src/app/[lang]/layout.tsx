import type { Metadata, Viewport } from "next";
import { notFound } from "next/navigation";
import localFont from "next/font/local";
import "../globals.css";
import { I18nProvider } from "@/components/I18n";
import { clientDict } from "@/lib/i18n/meta";
import { Header } from "@/components/Header";
import { Footer } from "@/components/Footer";
import { ServiceWorker } from "@/components/ServiceWorker";
import { ExtensionHandoff } from "@/components/ExtensionHandoff";
import { PointerLight } from "@/components/PointerLight";
import { getDictionary } from "@/lib/i18n/dictionary";
import { hasLocale, isRtl, LOCALE_CODES } from "@/lib/i18n/locales";
import { BRAND, SITE_URL } from "@/lib/brand";
import { THEME_SCRIPT } from "@/lib/theme";

// Committed in src/app/fonts, so builds never reach out to a font CDN.
const sans = localFont({ src: "../fonts/Geist-Variable.woff2", variable: "--font-geist-sans", weight: "100 900" });
const mono = localFont({ src: "../fonts/GeistMono-Variable.woff2", variable: "--font-geist-mono", weight: "100 900" });

export function generateStaticParams() {
  return LOCALE_CODES.map((lang) => ({ lang }));
}

export async function generateMetadata({ params }: LayoutProps<"/[lang]">): Promise<Metadata> {
  const { lang } = await params;
  if (!hasLocale(lang)) return {};
  const t = await getDictionary(lang);
  // Canonical and language links are per page (src/lib/seo.ts).
  return {
    metadataBase: new URL(SITE_URL),
    title: { default: `${BRAND.name}: ${t["home.title"]}`, template: `%s · ${BRAND.name}` },
    description: t["home.subtitle"],
    applicationName: BRAND.name,
    icons: {
      icon: [{ url: "/favicon.ico", sizes: "48x48" }, { url: "/icon.svg", type: "image/svg+xml" }],
      apple: "/apple-touch-icon.png",
    },
    manifest: "/manifest.webmanifest",
  };
}

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f3f0e8" },
    { media: "(prefers-color-scheme: dark)", color: "#110f0c" },
  ],
};

export default async function RootLayout({ children, params }: LayoutProps<"/[lang]">) {
  const { lang } = await params;
  if (!hasLocale(lang)) notFound();
  const dict = await getDictionary(lang);
  return (
    // suppressHydrationWarning: THEME_SCRIPT sets data-theme on <html> before React loads.
    <html lang={lang} dir={isRtl(lang) ? "rtl" : "ltr"} className={`${sans.variable} ${mono.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body className="flex min-h-dvh flex-col">
        <I18nProvider locale={lang} dict={clientDict(dict)}>
          <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[60] focus:rounded-lg focus:bg-surface focus:px-3 focus:py-2">
            {dict["nav.skip"]}
          </a>
          <Header />
          {/* Decoration hangs past the edges; clip it without making a scroll container (sticky still works). */}
          <main id="main" className="flex-1 overflow-x-clip">
            <ExtensionHandoff />
            {children}
          </main>
          <Footer />
          <ServiceWorker />
          <PointerLight />
        </I18nProvider>
      </body>
    </html>
  );
}
