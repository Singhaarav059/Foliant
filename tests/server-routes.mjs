// The server build's API routes, through `next start`: CSRF, body and type
// limits, blocked addresses and error messages. Needs a server build first (`npm run build`).
//
//   npm run test:server-routes
import { spawn } from "node:child_process";
import { createServer, request } from "node:http";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
if (!existsSync(join(root, ".next/BUILD_ID"))) {
  console.error("No server build. Run `npm run build` first.");
  process.exit(1);
}

const PORT = 3299;
const BASE = `http://localhost:${PORT}`;
const data = mkdtempSync(join(tmpdir(), "server-routes-"));
const server = spawn(join(root, "node_modules/.bin/next"), ["start", "-p", String(PORT)], {
  cwd: root,
  env: { ...process.env, DATA_DIR: data, TRUST_PROXY_HOPS: "1", PORT: String(PORT) },
  stdio: ["ignore", "pipe", "pipe"],
});
let log = "";
server.stdout.on("data", (d) => (log += d));
server.stderr.on("data", (d) => (log += d));
const stop = () => {
  server.kill();
  rmSync(data, { recursive: true, force: true });
};

for (let i = 0; ; i++) {
  try {
    await fetch(`${BASE}/api/capabilities`);
    break;
  } catch {
    if (i > 60) {
      console.error(log);
      stop();
      process.exit(1);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ✗ ${name}\n      ${e?.stack?.split("\n").slice(0, 3).join("\n      ") ?? e}`);
  }
}
function ok(cond, msg) {
  if (!cond) throw new Error(msg);
}
const eq = (a, b, msg) => ok(Object.is(a, b), `${msg}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);

// Headers a browser on this site sends; each test client also plays the
// reverse proxy and appends its own address to X-Forwarded-For.
let clientNo = 0;
const site = (ip = `198.51.100.${++clientNo % 250}`) => ({
  origin: BASE, "sec-fetch-site": "same-origin", "x-forwarded-for": ip,
});
const post = (path, body, { headers = site(), cookie, type = "application/json", method = "POST" } = {}) =>
  fetch(`${BASE}${path}`, {
    method,
    headers: { ...headers, ...(type ? { "content-type": type } : {}), ...(cookie ? { cookie } : {}) },
    body: typeof body === "string" || body instanceof FormData ? body : body === undefined ? undefined : JSON.stringify(body),
    redirect: "manual",
  });

try {
  await test("API responses aren't cached, framed or fingerprinted", async () => {
    const res = await fetch(`${BASE}/api/capabilities`);
    eq(res.headers.get("cache-control"), "no-store", "cache-control");
    eq(res.headers.get("x-frame-options"), "SAMEORIGIN", "x-frame-options");
    ok(/frame-ancestors 'self'/.test(res.headers.get("content-security-policy") ?? ""), "frame-ancestors");
    eq(res.headers.get("x-content-type-options"), "nosniff", "nosniff");
    eq(res.headers.get("x-powered-by"), null, "x-powered-by");
  });

  await test("cross-site requests can't change state", async () => {
    const body = { email: "csrf@example.com", message: "A message from another site" };
    eq((await post("/api/contact", body, { headers: { ...site(), origin: "https://evil.test", "sec-fetch-site": "cross-site" } })).status, 403, "foreign origin");
    eq((await post("/api/contact", body, { headers: { "sec-fetch-site": "same-site", "x-forwarded-for": "198.51.100.1" } })).status, 403, "sibling subdomain");
    eq((await post("/api/contact", JSON.stringify(body), { headers: { "x-forwarded-for": "198.51.100.1" }, type: "text/plain" })).status, 415, "text/plain form post");
    const fd = new FormData();
    fd.append("url", "https://example.com");
    eq((await post("/api/convert/html", fd, { headers: { ...site(), origin: "https://evil.test", "sec-fetch-site": "cross-site" }, type: null })).status, 403, "conversion from another site");
  });

  await test("bad input gets a 4xx, not a crash", async () => {
    eq((await post("/api/contact", "{not json")).status, 400, "invalid JSON");
    eq((await post("/api/contact", { email: "a@b.co", message: "x".repeat(200_000) })).status, 413, "huge JSON");
    eq((await post("/api/contact", ["array"])).status, 400, "not an object");
  });

  await test("uploads: size is checked before parsing, and content must match the extension", async () => {
    // Declares 10 GB and sends a few bytes: a server that waits for the body hangs.
    const huge = await new Promise((resolve) => {
      const r = request(`${BASE}/api/convert/office`, {
        method: "POST",
        headers: { ...site(), "content-type": "multipart/form-data; boundary=x", "content-length": String(10 * 1024 * 1024 * 1024) },
        timeout: 10_000,
      }, (res) => { res.resume(); resolve({ status: res.statusCode }); });
      r.on("timeout", () => { r.destroy(); resolve({ status: "no answer in 10 s" }); });
      r.on("error", (e) => resolve({ status: `error ${e.code}` }));
      r.write("--x\r\n");
    });
    eq(huge.status, 413, "declared 10 GB");
    const fd = new FormData();
    fd.append("file", new File(["%PDF-1.7 not a document"], "report.docx"));
    const res = await post("/api/convert/office", fd, { type: null });
    eq(res.status, 415, "a PDF named .docx");
    const html = new FormData();
    html.append("file", new File([new Uint8Array([0x50, 0x4b, 3, 4, 0, 0, 0])], "page.html"));
    eq((await post("/api/convert/html", html, { type: null })).status, 415, "a zip named .html");
  });

  await test("web capture refuses addresses inside the server's network", async () => {
    for (const url of [
      "http://127.0.0.1/", "http://localhost:3000/", "http://[::1]/", "http://169.254.169.254/latest/meta-data/",
      "http://[64:ff9b::a00:1]/", "http://[2002:0a00:0001::]/", "http://[::ffff:10.0.0.1]/", "http://2130706433/",
      "http://0x7f.1/", "file:///etc/passwd", "gopher://127.0.0.1:25/",
    ]) {
      const fd = new FormData();
      fd.append("url", url);
      const res = await post("/api/convert/html", fd, { type: null });
      ok(res.status === 400, `${url}: ${res.status}`);
    }
  });

  const caps = await (await fetch(`${BASE}/api/capabilities`)).json();
  if (caps.chrome)
    await test("a printed page can't reach the server's network, however it asks", async () => {
      const hits = [];
      const internal = createServer((req, res) => {
        hits.push(req.url);
        res.end("internal");
      });
      await new Promise((r) => internal.listen(0, "127.0.0.1", r));
      const p = internal.address().port;
      const page = `<!doctype html><title>t</title>
        <img src="http://127.0.0.1:${p}/img"><img src="http://localhost:${p}/img2"><img src="http://[::ffff:127.0.0.1]:${p}/img3">
        <iframe src="http://127.0.0.1:${p}/frame"></iframe>
        <link rel="stylesheet" href="http://127.0.0.1:${p}/css">
        <script>
          fetch("http://127.0.0.1:${p}/fetch").catch(() => {});
          new Image().src = "http://localhost.:${p}/js-img";
          try { new WebSocket("ws://127.0.0.1:${p}/ws"); } catch {}
        </script>
        <meta http-equiv="refresh" content="0;url=http://127.0.0.1:${p}/refresh">
        <p>hello</p>`;
      const fd = new FormData();
      fd.append("file", new File([page], "page.html", { type: "text/html" }));
      const res = await post("/api/convert/html", fd, { type: null });
      await res.arrayBuffer();
      internal.close();
      eq(hits.length, 0, `internal server reached: ${hits.join(", ")}`);
    });

  await test("a failed conversion says nothing about the server", async () => {
    const fd = new FormData();
    // A zip that isn't an Office document: every engine fails on it.
    fd.append("file", new File([new Uint8Array([0x50, 0x4b, 3, 4, ...new Array(200).fill(7)])], "broken.docx"));
    const res = await post("/api/convert/office", fd, { type: null });
    ok(res.status >= 400, `status ${res.status}`);
    const { error } = await res.json();
    ok(!/\/(tmp|var|usr|Applications|private)\b|[A-Z]:\\|ENOENT|Error:|at \w+ \(|soffice|chromium|playwright/i.test(error), `leaks: ${error}`);
  });
} finally {
  stop();
}

console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
