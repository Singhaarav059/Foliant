// One place to rename the product and to say where it lives and who runs
// it (plus public/manifest.webmanifest, which is a plain file so static
// builds can serve it, and the icons scripts/icons.mjs draws from the logo).
export const BRAND = {
  name: "Nopload",
  tagline: "Every PDF tool, private by default",
};

// Site settings that differ per deployment. Set them as environment variables
// when building (or in .env.production.local). Until they are set, pages show
// the placeholders below, and a release build (NOPLOAD_RELEASE=1) stops with
// a list of what is missing, so placeholders never go live.
const SETTINGS = {
  // The public address, without a trailing slash: canonical links, language
  // alternates, the sitemap and social cards use it. ".example" is reserved,
  // so the placeholder can never point at someone else's site.
  NEXT_PUBLIC_SITE_URL: { value: process.env.NEXT_PUBLIC_SITE_URL, placeholder: "https://nopload.example" },
  // Who runs the site, a person or a company, as the privacy policy and
  // terms name them.
  NEXT_PUBLIC_OPERATOR_NAME: { value: process.env.NEXT_PUBLIC_OPERATOR_NAME, placeholder: "[operator name]" },
  // Where the operator is based. Its law governs the terms.
  NEXT_PUBLIC_OPERATOR_COUNTRY: { value: process.env.NEXT_PUBLIC_OPERATOR_COUNTRY, placeholder: "[country]" },
  // How people reach the operator: an email address or an https:// page.
  NEXT_PUBLIC_OPERATOR_CONTACT: { value: process.env.NEXT_PUBLIC_OPERATOR_CONTACT, placeholder: "[contact email]" },
};

const setting = (s: { value?: string; placeholder: string }) => s.value?.trim() || s.placeholder;

export const SITE_URL = setting(SETTINGS.NEXT_PUBLIC_SITE_URL).replace(/\/+$/, "");

const contact = setting(SETTINGS.NEXT_PUBLIC_OPERATOR_CONTACT);
const email = /^[^\s@/:]+@[^\s@/]+\.[^\s@/]+$/.test(contact);
export const OPERATOR = {
  name: setting(SETTINGS.NEXT_PUBLIC_OPERATOR_NAME),
  country: setting(SETTINGS.NEXT_PUBLIC_OPERATOR_COUNTRY),
  contact,
  // A link for the contact, or "" while it is a placeholder.
  contactHref: email ? `mailto:${contact}` : /^https:\/\//.test(contact) ? contact : "",
};

// What a release build still needs, as messages. Read by next.config.ts.
export function releaseGaps() {
  const gaps = Object.entries(SETTINGS)
    .filter(([, s]) => setting(s) === s.placeholder)
    .map(([name]) => `${name} is not set`);
  if (!/^https:\/\/[^/]+$/.test(SITE_URL)) gaps.push(`NEXT_PUBLIC_SITE_URL must be https://host, without a path (got ${SITE_URL})`);
  if (contact !== SETTINGS.NEXT_PUBLIC_OPERATOR_CONTACT.placeholder && !OPERATOR.contactHref)
    gaps.push(`NEXT_PUBLIC_OPERATOR_CONTACT must be an email address or an https:// URL (got ${contact})`);
  return gaps;
}
