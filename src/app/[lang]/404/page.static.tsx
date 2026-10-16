import NotFound from "../not-found";

// Static build only: emitted as /{lang}/404.html, which hosts such as
// Cloudflare Pages serve for missing pages under that language.
export default function NotFoundPage() {
  return <NotFound />;
}
