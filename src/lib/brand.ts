// One place to rename the product and to say where it lives (plus
// public/manifest.webmanifest, which is a plain file so static builds can
// serve it, and the icons made from public/icon.svg by scripts/icons.mjs).
export const BRAND = {
  name: "Foliant",
  tagline: "Every PDF tool, private by default",
};

// Site settings that differ per deployment. Set them as environment variables
// when building (or in .env.production.local). Until they are set, pages show
// the placeholders below, and a release build (FOLIANT_RELEASE=1) stops with
// a list of what is missing, so placeholders never go live.
const SETTINGS = {
  // The public address, without a trailing slash: canonical links, language
  // alternates, the sitemap and social cards use it. ".example" is reserved,
  // so the placeholder can never point at someone else's site.
  NEXT_PUBLIC_SITE_URL: { value: process.env.NEXT_PUBLIC_SITE_URL, placeholder: "https://foliant.example" },
};

const setting = (s: { value?: string; placeholder: string }) => s.value?.trim() || s.placeholder;

export const SITE_URL = setting(SETTINGS.NEXT_PUBLIC_SITE_URL).replace(/\/+$/, "");

// What a release build still needs, as messages. Read by next.config.ts.
export function releaseGaps() {
  const gaps = Object.entries(SETTINGS)
    .filter(([, s]) => setting(s) === s.placeholder)
    .map(([name]) => `${name} is not set`);
  if (!/^https:\/\/[^/]+$/.test(SITE_URL)) gaps.push(`NEXT_PUBLIC_SITE_URL must be https://host, without a path (got ${SITE_URL})`);
  return gaps;
}
