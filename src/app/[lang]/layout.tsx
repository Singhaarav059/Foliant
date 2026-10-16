import type { Metadata, Viewport } from "next";
import { notFound } from "next/navigation";
import { Geist, Geist_Mono } from "next/font/google";
import "../globals.css";
import { I18nProvider } from "@/components/I18n";
import { UserProvider } from "@/components/User";
import { Header } from "@/components/Header";
import { Footer } from "@/components/Footer";
import { ServiceWorker } from "@/components/ServiceWorker";
import { getDictionary } from "@/lib/i18n/dictionary";
import { hasLocale, isRtl, LOCALE_CODES } from "@/lib/i18n/locales";
import { BRAND } from "@/lib/brand";

const sans = Geist({ variable: "--font-geist-sans", subsets: ["latin", "latin-ext", "cyrillic"] });
const mono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export function generateStaticParams() {
  return LOCALE_CODES.map((lang) => ({ lang }));
}

export async function generateMetadata({ params }: LayoutProps<"/[lang]">): Promise<Metadata> {
  const { lang } = await params;
  if (!hasLocale(lang)) return {};
  const t = await getDictionary(lang);
  return {
    title: { default: `${BRAND.name}: ${t["home.title"]}`, template: `%s · ${BRAND.name}` },
    description: t["home.subtitle"],
    applicationName: BRAND.name,
    icons: { icon: "/icon.svg", apple: "/icon-maskable.svg" },
    manifest: "/manifest.webmanifest",
    alternates: { languages: Object.fromEntries(LOCALE_CODES.map((l) => [l, `/${l}`])) },
  };
}

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f5f6f8" },
    { media: "(prefers-color-scheme: dark)", color: "#0d1016" },
  ],
};

export default async function RootLayout({ children, params }: LayoutProps<"/[lang]">) {
  const { lang } = await params;
  if (!hasLocale(lang)) notFound();
  const dict = await getDictionary(lang);
  return (
    <html lang={lang} dir={isRtl(lang) ? "rtl" : "ltr"} className={`${sans.variable} ${mono.variable}`}>
      <body className="flex min-h-dvh flex-col">
        <I18nProvider locale={lang} dict={dict}>
          <UserProvider>
            <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[60] focus:rounded-lg focus:bg-surface focus:px-3 focus:py-2">
              {dict["nav.skip"]}
            </a>
            <Header />
            <main id="main" className="flex-1">{children}</main>
            <Footer />
            <ServiceWorker />
          </UserProvider>
        </I18nProvider>
      </body>
    </html>
  );
}
