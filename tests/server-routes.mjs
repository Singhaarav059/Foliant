// The server build's API routes, through `next start`: CSRF, brute force,
// session revocation, body and type limits, blocked addresses and error
// messages. Needs a server build first (`npm run build`).
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
  env: { ...process.env, DATA_DIR: data, AUTH_SECRET: "test-secret-".padEnd(48, "x"), TRUST_PROXY_HOPS: "1", PORT: String(PORT) },
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
const cookieOf = (res) => res.headers.get("set-cookie")?.split(";")[0] ?? "";
const me = async (cookie) => (await (await fetch(`${BASE}/api/auth/me`, { headers: { cookie } })).json()).user;
const email = (n) => `user${n}-${Date.now()}@example.com`;

try {
  await test("API responses aren't cached, framed or fingerprinted", async () => {
    const res = await fetch(`${BASE}/api/auth/me`);
    eq(res.headers.get("cache-control"), "no-store", "cache-control");
    eq(res.headers.get("x-frame-options"), "SAMEORIGIN", "x-frame-options");
    ok(/frame-ancestors 'self'/.test(res.headers.get("content-security-policy") ?? ""), "frame-ancestors");
    eq(res.headers.get("x-content-type-options"), "nosniff", "nosniff");
    eq(res.headers.get("x-powered-by"), null, "x-powered-by");
  });

  await test("cross-site requests can't change state", async () => {
    const body = { email: email("csrf"), password: "correct horse battery" };
    eq((await post("/api/auth/register", body, { headers: { ...site(), origin: "https://evil.test", "sec-fetch-site": "cross-site" } })).status, 403, "foreign origin");
    eq((await post("/api/auth/register", body, { headers: { "sec-fetch-site": "same-site", "x-forwarded-for": "198.51.100.1" } })).status, 403, "sibling subdomain");
    eq((await post("/api/auth/register", JSON.stringify(body), { headers: { "x-forwarded-for": "198.51.100.1" }, type: "text/plain" })).status, 415, "text/plain form post");
    const fd = new FormData();
    fd.append("url", "https://example.com");
    eq((await post("/api/convert/html", fd, { headers: { ...site(), origin: "https://evil.test", "sec-fetch-site": "cross-site" }, type: null })).status, 403, "conversion from another site");
  });

  await test("bad input gets a 4xx, not a crash", async () => {
    eq((await post("/api/contact", "{not json")).status, 400, "invalid JSON");
    eq((await post("/api/contact", { email: "a@b.co", message: "x".repeat(200_000) })).status, 413, "huge JSON");
    eq((await post("/api/auth/login", ["array"])).status, 400, "not an object");
  });

  await test("sessions: HttpOnly, SameSite, and fresh on every sign-in", async () => {
    const mail = email("session");
    const reg = await post("/api/auth/register", { email: mail, password: "first password 1" });
    eq(reg.status, 200, "register");
    const setCookie = reg.headers.get("set-cookie") ?? "";
    ok(/HttpOnly/i.test(setCookie) && /SameSite=lax/i.test(setCookie), `cookie flags: ${setCookie}`);
    ok(/^__Host-session=/.test(setCookie) && /Secure/i.test(setCookie) && /Path=\//.test(setCookie) && !/Domain=/i.test(setCookie), `__Host- cookie: ${setCookie}`);
    const a = cookieOf(reg);
    const b = cookieOf(await post("/api/auth/login", { email: mail, password: "first password 1" }));
    ok(a && b && a !== b, "a new token on sign-in");
    const preset = `__Host-session=attacker-chosen`;
    const c = await post("/api/auth/login", { email: mail, password: "first password 1" }, { cookie: preset });
    ok(cookieOf(c) !== preset, "a pre-set cookie is replaced, not adopted");
  });

  await test("changing the password signs out every other session", async () => {
    const mail = email("revoke");
    const a = cookieOf(await post("/api/auth/register", { email: mail, password: "first password 1" }));
    const b = cookieOf(await post("/api/auth/login", { email: mail, password: "first password 1" }));
    eq((await me(a))?.email, mail, "first session works");
    const change = await post("/api/auth/password", { current: "first password 1", next: "second password 2" }, { cookie: b });
    eq(change.status, 200, "password changed");
    const c = cookieOf(change);
    eq(await me(a), null, "the other session is revoked");
    eq(await me(b), null, "the old token of this session is revoked");
    eq((await me(c))?.email, mail, "this browser stays signed in with a new token");
  });

  await test("signing out revokes the token, not just the cookie", async () => {
    const mail = email("logout");
    const a = cookieOf(await post("/api/auth/register", { email: mail, password: "first password 1" }));
    eq((await post("/api/auth/logout", undefined, { cookie: a, type: null })).status, 200, "logout");
    eq(await me(a), null, "a copied token no longer works");
  });

  await test("one address can't brute-force sign-in, whatever X-Forwarded-For it claims", async () => {
    const statuses = [];
    for (let i = 0; i < 22; i++) {
      const r = await post("/api/auth/login", { email: email(`nobody${i}`), password: "wrong password" }, { headers: site(`10.${i}.0.1, 203.0.113.9`) });
      statuses.push(r.status);
    }
    eq(statuses.at(-1), 429, `limited after 20 (${statuses.join(",")})`);
  });

  await test("many addresses can't brute-force one account", async () => {
    const mail = email("target");
    await post("/api/auth/register", { email: mail, password: "the real password" });
    const statuses = [];
    for (let i = 0; i < 11; i++)
      statuses.push((await post("/api/auth/login", { email: mail, password: `guess ${i}` }, { headers: site(`203.0.113.${100 + i}`) })).status);
    eq(statuses.at(-1), 429, `account locked after 10 failures (${statuses.join(",")})`);
    eq((await post("/api/auth/login", { email: mail, password: "the real password" }, { headers: site("203.0.113.200") })).status, 429, "even the right password waits");
  });

  await test("the current password can't be guessed through a stolen session", async () => {
    const mail = email("pwguess");
    const a = cookieOf(await post("/api/auth/register", { email: mail, password: "first password 1" }));
    const statuses = [];
    for (let i = 0; i < 11; i++) statuses.push((await post("/api/auth/password", { current: `guess ${i}`, next: "whatever123" }, { cookie: a })).status);
    eq(statuses.at(-1), 429, `password change limited (${statuses.join(",")})`);
    const del = [];
    for (let i = 0; i < 11; i++) del.push((await post("/api/auth/delete", { password: `guess ${i}` }, { cookie: a })).status);
    eq(del.at(-1), 429, `account deletion limited (${del.join(",")})`);
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
