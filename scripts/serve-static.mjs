// Serves the static build like Cloudflare Pages does, for local checks and
// the end-to-end tests: /a → a.html or a/index.html, a missing path gets the
// nearest 404.html with status 404, and every response carries the headers
// that out/_headers assigns to its path.
// Usage: node scripts/serve-static.mjs [dir=out] [port=3202]
import { createServer } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";

const root = resolve(process.argv[2] ?? "out");
const port = Number(process.argv[3] ?? 3202);
const types = {
  ".html": "text/html; charset=utf-8", ".txt": "text/plain; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript",
  ".css": "text/css", ".json": "application/json", ".webmanifest": "application/manifest+json", ".svg": "image/svg+xml",
  ".wasm": "application/wasm", ".woff2": "font/woff2", ".woff": "font/woff", ".png": "image/png", ".jpg": "image/jpeg",
  ".xml": "application/xml", ".gz": "application/gzip",
};
const isFile = (p) => existsSync(p) && statSync(p).isFile();

// _headers: a path pattern on its own line, then indented "Name: value"
// lines. "*" matches anything and ":name" one path segment. Every matching
// rule applies, and a header set by several rules gets their values joined.
// "! Name" drops what earlier rules set for that header (Cloudflare's detach).
function parseHeaders(text) {
  const rules = [];
  for (const line of text.split("\n")) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    if (!/^\s/.test(line)) {
      const source = line.trim().replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/:\w+/g, "[^/]+");
      rules.push({ match: new RegExp(`^${source}$`), headers: [] });
    } else if (rules.length && line.trim().startsWith("!")) {
      rules.at(-1).headers.push([line.trim().slice(1).trim(), null]);
    } else if (rules.length) {
      const at = line.indexOf(":");
      if (at > 0) rules.at(-1).headers.push([line.slice(0, at).trim(), line.slice(at + 1).trim()]);
    }
  }
  return (path) => {
    const out = {};
    for (const rule of rules.filter((r) => r.match.test(path))) {
      for (const [name, value] of rule.headers) {
        if (value === null) delete out[name];
        else out[name] = out[name] ? `${out[name]}, ${value}` : value;
      }
    }
    return out;
  };
}

const headersFor = isFile(join(root, "_headers")) ? parseHeaders(readFileSync(join(root, "_headers"), "utf8")) : () => ({});

const server = createServer((req, res) => {
  // A request the URL parser or the decoder rejects ("//", a bad %-escape)
  // gets a 400; thrown here, it would stop the server for every later test.
  let path;
  try {
    path = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
  } catch {
    return res.writeHead(400).end();
  }
  const target = join(root, path);
  if (!target.startsWith(root)) return res.writeHead(400).end();
  let file = [target, `${target}.html`, join(target, "index.html")].find(isFile);
  let status = 200;
  if (!file) {
    status = 404;
    for (let dir = target; dir.startsWith(root); dir = dirname(dir)) {
      if (isFile(join(dir, "404.html"))) { file = join(dir, "404.html"); break; }
      if (dir === root) break;
    }
  }
  if (!file) return res.writeHead(404, headersFor(path)).end("Not found");
  res.writeHead(status, { ...headersFor(path), "Content-Type": types[extname(file)] ?? "application/octet-stream" });
  res.end(readFileSync(file));
});
// Port 0 picks a free port; the line below says which.
server.listen(port, () => console.log(`Serving ${root} on http://localhost:${server.address().port}`));
