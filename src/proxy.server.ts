import { NextResponse, type NextRequest } from "next/server";
import { hasLocale, matchLocale } from "@/lib/i18n/locales";

// Every page lives under a locale prefix. Requests without one are sent to
// the visitor's saved or preferred language.
export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const first = pathname.split("/")[1] ?? "";
  if (hasLocale(first)) {
    // Remember the language in use, so a bare "/" later returns to it.
    if (request.cookies.get("locale")?.value === first) return;
    const res = NextResponse.next();
    res.cookies.set("locale", first, { path: "/", maxAge: 60 * 60 * 24 * 365, sameSite: "lax" });
    return res;
  }
  const saved = request.cookies.get("locale")?.value;
  const locale = saved && hasLocale(saved) ? saved : matchLocale(request.headers.get("accept-language"));
  const url = request.nextUrl.clone();
  url.pathname = `/${locale}${pathname === "/" ? "" : pathname}`;
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/((?!api|_next|vendor|sw\\.js|manifest\\.webmanifest|icon|apple-icon|favicon|robots\\.txt|sitemap\\.xml|.*\\..*).*)"],
};
