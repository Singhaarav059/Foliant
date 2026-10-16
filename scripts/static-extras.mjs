// Finishes the static build in ./out (npm run build:static):
// - _headers: security and caching headers, for hosts that read the file
//   (Cloudflare Pages, Netlify). The server build sets the same ones in
//   next.config.ts.
// - 404.html: the language picker, so links without a language prefix still
//   land. Missing pages inside a language get /{lang}/404.html on hosts that
//   look for the nearest one.
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const out = join(process.cwd(), "out");
const security = JSON.parse(readFileSync(join(process.cwd(), "security-headers.json"), "utf8"));

const rules = [
  ["/*", security.map((h) => `${h.key}: ${h.value}`)],
  ["/sw.js", ["Cache-Control: no-cache"]],
  ["/_next/static/*", ["Cache-Control: public, max-age=31536000, immutable"]],
];
writeFileSync(join(out, "_headers"), rules.map(([path, lines]) => [path, ...lines.map((l) => `  ${l}`)].join("\n")).join("\n\n") + "\n");
copyFileSync(join(out, "index.html"), join(out, "404.html"));
console.log("static: wrote out/_headers and out/404.html");
