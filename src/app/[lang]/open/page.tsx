import type { Metadata } from "next";
import { OpenFiles } from "@/components/OpenFiles";
import { titleFrom } from "@/lib/i18n/meta";

// Where the installed app lands when files are shared to it or opened with
// it (public/manifest.webmanifest). Not a page to find through search.
export async function generateMetadata(props: PageProps<"/[lang]/open">): Promise<Metadata> {
  return { ...(await titleFrom("open.title")(props)), robots: { index: false } };
}

export default function OpenPage() {
  return <OpenFiles />;
}
