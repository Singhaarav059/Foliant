import { notFound } from "next/navigation";
import { ContactForm } from "@/components/ContactForm";
import { getDictionary } from "@/lib/i18n/dictionary";
import { hasLocale } from "@/lib/i18n/locales";
import { titleFrom } from "@/lib/i18n/meta";

export const generateMetadata = titleFrom("contact.title");

// Typed by hand: static builds leave this page out, so its generated PageProps type is missing.
export default async function Contact({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!hasLocale(lang)) notFound();
  const t = await getDictionary(lang);
  return (
    <div className="mx-auto max-w-[620px] px-4 pb-10 pt-14">
      <h1 className="display text-[2.9rem] sm:text-[3.6rem]">{t["contact.title"]}</h1>
      <p className="mb-8 mt-2 text-[16px] text-muted">{t["contact.body"]}</p>
      <ContactForm />
    </div>
  );
}
