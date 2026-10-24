// Turns the static build (./out, npm run build:static) into Vercel's Build
// Output API layout, so a Vercel deployment serves exactly what Cloudflare
// Pages or Netlify serve from the same folder:
// - .vercel/output/static: the files (out is moved, not copied: it's ~2 GB).
// - .vercel/output/config.json: the routes. Headers and redirects are read
//   from out/_headers and out/_redirects (scripts/static-extras.mjs writes
//   them), so there is one source for every host. Pages are served without
//   .html (/en → en.html), and a missing page gets its language's 404.
// Vercel counts each route against a 2,048-per-deployment limit; the build
// stops if the config would go past it.
// Usage: node scripts/vercel-output.mjs [dir=out]
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const out = resolve(process.argv[2] ?? "out");
const target = resolve(".vercel/output");
const MAX_ROUTES = 2048;

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// _headers paths: "*" matches the rest of the path, ":name" one segment.
const pattern = (path) => `^${escape(path).replaceAll("\\*", "(.*)").replace(/:[a-z]+/gi, "[^/]+")}$`;

// _headers: a path line, then indented "Name: value" lines; "! Name" drops
// a header set by an earlier rule (a later route with the same name does that here).
const headerRoutes = [];
for (const block of readFileSync(join(out, "_headers"), "utf8").split(/\n\s*\n/)) {
  const [path, ...lines] = block.split("\n").filter(Boolean);
  if (!path) continue;
  const headers = {};
  for (const line of lines.map((l) => l.trim())) {
    if (line.startsWith("!")) continue;
    const i = line.indexOf(":");
    headers[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  headerRoutes.push({ src: pattern(path.trim()), headers, continue: true });
}

const redirectFile = join(out, "_redirects");
const redirects = existsSync(redirectFile)
  ? readFileSync(redirectFile, "utf8").split("\n").filter(Boolean).map((line) => {
      const [from, to, status = "301"] = line.trim().split(/\s+/);
      return { src: `^${escape(from)}/?$`, headers: { Location: to }, status: Number(status) };
    })
  : [];

const routes = [
  ...redirects,
  ...headerRoutes,
  { handle: "filesystem" },
  // /en → /en.html, /en/merge-pdf/ → /en/merge-pdf.html
  { src: "^/(.+?)/?$", dest: "/$1.html", check: true },
  { handle: "error" },
  { status: 404, src: "^/([a-z]{2}(?:-[a-z]{2})?)/.*$", dest: "/$1/404.html" },
  { status: 404, src: "^/.*$", dest: "/404.html" },
];
if (routes.length > MAX_ROUTES) throw new Error(`${routes.length} routes; Vercel takes ${MAX_ROUTES} per deployment`);

rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
renameSync(out, join(target, "static"));
writeFileSync(join(target, "config.json"), JSON.stringify({ version: 3, routes }, null, 2) + "\n");
console.log(`vercel: .vercel/output with ${routes.length} routes (${redirects.length} redirects, ${headerRoutes.length} header rules)`);
