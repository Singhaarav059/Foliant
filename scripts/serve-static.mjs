// Serves the static build like Cloudflare Pages does, for local checks and
// the end-to-end tests: /a → a.html or a/index.html, and a missing path gets
// the nearest 404.html with status 404.
// Usage: node scripts/serve-static.mjs [dir=out] [port=3202]
import { createServer } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";

const root = resolve(process.argv[2] ?? "out");
const port = Number(process.argv[3] ?? 3202);
const types = {
  ".html": "text/html; charset=utf-8", ".txt": "text/plain; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript",
  ".css": "text/css", ".json": "application/json", ".webmanifest": "application/manifest+json", ".svg": "image/svg+xml",
  ".wasm": "application/wasm", ".woff2": "font/woff2", ".png": "image/png", ".jpg": "image/jpeg",
};
const isFile = (p) => existsSync(p) && statSync(p).isFile();

createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
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
  if (!file) return res.writeHead(404).end("Not found");
  res.writeHead(status, { "Content-Type": types[extname(file)] ?? "application/octet-stream" });
  res.end(readFileSync(file));
}).listen(port, () => console.log(`Serving ${root} on http://localhost:${port}`));
