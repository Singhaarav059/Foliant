// The server build's own defences, tested in Node without starting Next:
// which addresses a URL may reach, the egress proxy Chrome is pinned to, the
// rate limiter's client address, body and file-type limits, CSRF checks,
// subprocess limits and what an error is allowed to say.
// tests/server-routes.mjs runs the same rules through `next start`.
//
//   npm run test:server
import { execFileSync, spawnSync } from "node:child_process";
import { createServer, request } from "node:http";
import { connect } from "node:net";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { register } from "node:module";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = mkdtempSync(join(tmpdir(), "server-lib-"));
execFileSync(join(root, "node_modules/.bin/tsc"), [
  "--outDir", out, "--module", "esnext", "--target", "es2022", "--moduleResolution", "bundler",
  "--skipLibCheck", "--noCheck", "--rootDir", "src/lib/server",
  ...["net", "egress", "limits", "http", "run"].map((m) => `src/lib/server/${m}.ts`),
], { cwd: root, stdio: "inherit" });

// "server-only" throws outside a React server bundle; here it's a no-op.
writeFileSync(join(out, "hooks.mjs"), String.raw`
export async function resolve(spec, ctx, next) {
  if (spec === "server-only") return { url: "data:text/javascript,", shortCircuit: true };
  if (/^\.\.?\//.test(spec) && !/\.m?js$/.test(spec)) return next(spec + ".js", ctx);
  return next(spec, ctx);
}`);
register(pathToFileURL(join(out, "hooks.mjs")));
const load = (name) => import(pathToFileURL(join(out, `${name}.js`)).href);

const net = await load("net");
const egress = await load("egress");
const limits = await load("limits");
const http = await load("http");
const run = await load("run");

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

// ── Addresses ─────────────────────────────────────────────────────────────

await test("private, reserved and transition IPv4 addresses are blocked", () => {
  for (const ip of [
    "0.0.0.0", "10.1.2.3", "100.64.0.1", "127.0.0.1", "127.255.255.254", "169.254.169.254", "172.16.0.1",
    "172.31.255.255", "192.0.0.8", "192.0.2.1", "192.88.99.1", "192.168.1.1", "198.18.0.1", "198.51.100.7",
    "203.0.113.9", "224.0.0.1", "240.0.0.1", "255.255.255.255",
  ]) ok(net.blockedIp(ip), `${ip} should be blocked`);
});

await test("IPv6 addresses that reach IPv4 or the local network are blocked", () => {
  for (const ip of [
    "::", "::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "::127.0.0.1", "::a00:1", "::ffff:0:a00:1",
    "64:ff9b::a00:1", "64:ff9b::7f00:1", "64:ff9b::8.8.8.8", "64:ff9b:1::a00:1",
    "2002:0a00:0001::", "2002:7f00:1::1", "2002:808:808::1", "2001:0:4136:e378:8000:63bf:3fff:fdd2",
    "2001:db8::1", "100::1", "fc00::1", "fd12:3456::1", "fe80::1", "febf::1", "fec0::1", "ff02::1",
    "[::1]", "0:0:0:0:0:0:0:1", "::ffff:169.254.169.254",
  ]) ok(net.blockedIp(ip), `${ip} should be blocked`);
});

await test("public addresses are allowed", () => {
  for (const ip of ["8.8.8.8", "1.1.1.1", "93.184.215.14", "172.32.0.1", "100.128.0.1", "2606:4700:4700::1111", "2a00:1450:4001:80b::200e"])
    ok(!net.blockedIp(ip), `${ip} should be allowed`);
  for (const junk of ["", "example.com", "1.2.3", "::g", "1.2.3.4.5"]) ok(net.blockedIp(junk), `"${junk}" isn't an address`);
});

await test("a host name resolves once to an address that can be dialled", async () => {
  const lookup = (answers) => async () => answers.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
  eq(await net.resolvePublic("example.com", lookup(["93.184.215.14"])), "93.184.215.14", "public");
  eq(await net.resolvePublic("mixed.test", lookup(["93.184.215.14", "10.0.0.1"])), null, "any private answer refuses the name");
  eq(await net.resolvePublic("nat64.test", lookup(["64:ff9b::a00:1"])), null, "NAT64 answer");
  eq(await net.resolvePublic("[::1]", lookup(["93.184.215.14"])), null, "bracketed literal isn't looked up");
  eq(await net.resolvePublic("8.8.8.8", lookup(["10.0.0.1"])), "8.8.8.8", "literal isn't looked up");
  eq(await net.resolvePublic("localhost.", lookup(["93.184.215.14"])), null, "localhost with a trailing dot");
  eq(await net.resolvePublic("printer.local", lookup(["93.184.215.14"])), null, "mDNS name");
  eq(await net.resolvePublic("gone.test", async () => { throw new Error("ENOTFOUND"); }), null, "unresolvable");
});

await test("Chrome may only load http, https, data and blob URLs", () => {
  for (const u of ["https://example.com/", "http://example.com:8080/x", "data:text/html,hi", "blob:https://example.com/1"])
    ok(net.allowedScheme(new URL(u)), `${u} should be allowed`);
  for (const u of ["file:///etc/passwd", "ftp://example.com/", "chrome://settings", "javascript:alert(1)", "ws://example.com/", "view-source:https://example.com"])
    ok(!net.allowedScheme(new URL(u)), `${u} should be refused`);
});

// ── Egress proxy ──────────────────────────────────────────────────────────

const upstreamHits = [];
const upstream = createServer((req, res) => {
  upstreamHits.push(req.url);
  if (req.url === "/redirect") {
    res.writeHead(302, { Location: `http://127.0.0.1:${upstream.address().port}/secret` });
    return res.end();
  }
  res.end("upstream");
});
await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
const upPort = upstream.address().port;

function viaProxy(proxyPort, url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = request({ host: "127.0.0.1", port: proxyPort, method: "GET", path: url, headers: { Host: u.host } }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode, body, location: res.headers.location }));
    });
    req.on("error", reject);
    req.end();
  });
}
function connectVia(proxyPort, target) {
  return new Promise((resolve, reject) => {
    const s = connect(proxyPort, "127.0.0.1", () => s.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
    s.once("data", (d) => {
      s.destroy();
      resolve(Number(String(d).split(" ")[1]));
    });
    s.on("error", reject);
  });
}

await test("the egress proxy refuses private destinations, by name or by address", async () => {
  const proxy = await egress.startEgressProxy();
  try {
    upstreamHits.length = 0;
    eq((await viaProxy(proxy.port, `http://127.0.0.1:${upPort}/`)).status, 403, "loopback literal");
    eq((await viaProxy(proxy.port, `http://localhost:${upPort}/`)).status, 403, "localhost");
    eq((await viaProxy(proxy.port, `http://[::ffff:127.0.0.1]:${upPort}/`)).status, 403, "mapped loopback");
    eq(await connectVia(proxy.port, `127.0.0.1:${upPort}`), 403, "CONNECT to loopback");
    eq(await connectVia(proxy.port, `[64:ff9b::7f00:1]:443`), 403, "CONNECT to NAT64 loopback");
    eq(upstreamHits.length, 0, "nothing reached the private server");
  } finally {
    await proxy.close();
  }
});

await test("the egress proxy dials the address it checked, so DNS rebinding can't switch it", async () => {
  // The test's "public" address is the local upstream; the name then rebinds to a blocked one.
  let calls = 0;
  const answers = ["127.0.0.1", "127.0.0.2"];
  const proxy = await egress.startEgressProxy({
    lookup: async () => [{ address: answers[Math.min(calls++, 1)], family: 4 }],
    allow: (ip) => ip === "127.0.0.1",
  });
  try {
    upstreamHits.length = 0;
    const res = await viaProxy(proxy.port, `http://rebind.test:${upPort}/page`);
    eq(res.status, 200, "pinned request goes through");
    eq(calls, 1, "one lookup per request");
    eq(upstreamHits[0], "/page", "upstream got the request");
    eq((await viaProxy(proxy.port, `http://rebind.test:${upPort}/again`)).status, 403, "rebound answer refused");
  } finally {
    await proxy.close();
  }
});

await test("a redirect to an internal host is refused when the browser follows it", async () => {
  const proxy = await egress.startEgressProxy({
    lookup: async (h) => [{ address: h === "public.test" ? "127.0.0.1" : "127.0.0.2", family: 4 }],
    allow: (ip) => ip === "127.0.0.1",
  });
  try {
    const first = await viaProxy(proxy.port, `http://public.test:${upPort}/redirect`);
    eq(first.status, 302, "redirect passed through, not followed by the proxy");
    upstreamHits.length = 0;
    const internal = new URL(first.location);
    internal.hostname = "internal.test";
    eq((await viaProxy(proxy.port, internal.href)).status, 403, "the followed redirect");
    eq(upstreamHits.length, 0, "internal target not reached");
  } finally {
    await proxy.close();
  }
});

await test("the egress proxy only opens web ports", async () => {
  let dialled = 0;
  const proxy = await egress.startEgressProxy({ lookup: async () => { dialled++; return [{ address: "93.184.215.14", family: 4 }]; } });
  try {
    for (const port of [22, 25, 53, 110, 143, 445, 993])
      eq(await connectVia(proxy.port, `example.test:${port}`), 403, `port ${port}`);
    eq(dialled, 0, "refused before resolving");
  } finally {
    await proxy.close();
  }
});

upstream.close();

// ── Rate limiting ─────────────────────────────────────────────────────────

const req = (headers = {}) => new Request("http://app.test/api/x", { method: "POST", headers });

await test("the client address is the one the trusted proxy added, not the client's own claim", () => {
  eq(limits.clientIp(req({ "x-forwarded-for": "6.6.6.6, 203.0.113.50" }), 1), "203.0.113.50", "one proxy");
  eq(limits.clientIp(req({ "x-forwarded-for": "1.1.1.1, 2.2.2.2, 203.0.113.50" }), 1), "203.0.113.50", "spoofed chain");
  eq(limits.clientIp(req({ "x-forwarded-for": "6.6.6.6, 198.51.100.4, 10.0.0.2" }), 2), "198.51.100.4", "two proxies");
  eq(limits.clientIp(req({ "x-forwarded-for": "203.0.113.50" }), 2), "203.0.113.50", "fewer hops than configured");
  eq(limits.clientIp(req({ "x-forwarded-for": "6.6.6.6", "x-real-ip": "7.7.7.7" }), 0), "direct", "no proxy trusted");
  eq(limits.clientIp(req({ "x-forwarded-for": "not-an-ip" }), 1), "unknown", "garbage");
  eq(limits.clientIp(req({}), 1), "unknown", "no header");
  eq(limits.clientIp(req({ "x-forwarded-for": "2001:db8:1:2:aaaa::1" }), 1), limits.clientIp(req({ "x-forwarded-for": "2001:db8:1:2:bbbb::9" }), 1), "one IPv6 /64 is one client");
});

await test("the rate limiter ignores a spoofed X-Forwarded-For", () => {
  const key = (i) => `spoof:${limits.clientIp(req({ "x-forwarded-for": `10.9.${i}.1, 203.0.113.77` }), 1)}`;
  for (let i = 0; i < 5; i++) ok(limits.rateLimit(key(i), 5, 60_000), `attempt ${i + 1} allowed`);
  ok(!limits.rateLimit(key(99), 5, 60_000), "sixth attempt with a new spoofed address is limited");
});

await test("the rate limiter's memory stays bounded", async () => {
  for (let i = 0; i < 60_000; i++) limits.rateLimit(`flood:${i}`, 5, 60_000);
  ok(limits.trackedKeys() <= 50_000, `tracked ${limits.trackedKeys()} keys`);
  for (let i = 0; i < 5; i++) limits.rateLimit(`short:${i}`, 5, 1);
  await new Promise((r) => setTimeout(r, 5));
  limits.sweep();
  ok(limits.trackedKeys() < 50_000, "expired keys are swept");
});

await test("failures can be counted without being consumed", () => {
  for (let i = 0; i < 3; i++) limits.recordHit("acct:a@example.com");
  eq(limits.hitCount("acct:a@example.com", 60_000), 3, "three failures");
  limits.clearHits("acct:a@example.com");
  eq(limits.hitCount("acct:a@example.com", 60_000), 0, "cleared on success");
});

// ── Request bodies ────────────────────────────────────────────────────────

const streamOf = (bytes, chunk = 64 * 1024) => new ReadableStream({
  start(c) {
    for (let i = 0; i < bytes; i += chunk) c.enqueue(new Uint8Array(Math.min(chunk, bytes - i)));
    c.close();
  },
});

await test("bodies over the limit are refused before they're buffered", async () => {
  const big = new Request("http://app.test/", { method: "POST", headers: { "content-length": String(500 * 1024 * 1024) }, body: "x", duplex: "half" });
  await limits.readBody(big, 1024).then(() => { throw new Error("read"); }, (e) => eq(e.status, 413, "declared length"));
  const chunked = new Request("http://app.test/", { method: "POST", body: streamOf(2 * 1024 * 1024), duplex: "half" });
  await limits.readBody(chunked, 1024 * 1024).then(() => { throw new Error("read"); }, (e) => eq(e.status, 413, "streamed length"));
  const small = new Request("http://app.test/", { method: "POST", body: streamOf(1000), duplex: "half" });
  eq((await limits.readBody(small, 1024)).length, 1000, "under the limit");
});

await test("multipart uploads are size-checked before parsing", async () => {
  const fd = new FormData();
  fd.append("file", new File([new Uint8Array(3000)], "a.docx"));
  const r = new Request("http://app.test/", { method: "POST", body: fd });
  await limits.readForm(r, 1024).then(() => { throw new Error("parsed"); }, (e) => eq(e.status, 413, "too big"));
  const fd2 = new FormData();
  fd2.append("file", new File([new Uint8Array(10)], "a.docx"));
  const form = await limits.readForm(new Request("http://app.test/", { method: "POST", body: fd2 }), 1024);
  eq(form.get("file").size, 10, "small form parses");
});

await test("JSON routes need a JSON body of a sane size", async () => {
  const j = (body, type = "application/json") => new Request("http://app.test/", { method: "POST", headers: { "content-type": type }, body });
  const status = (p) => p.then(() => 200, (e) => e.status);
  eq(await status(http.readJson(j('{"a":1}', "text/plain"))), 415, "text/plain (a cross-site form can send it)");
  eq(await status(http.readJson(j('{"a":1}', "application/x-www-form-urlencoded"))), 415, "form encoding");
  eq(await status(http.readJson(j("{nope"))), 400, "invalid JSON");
  eq(await status(http.readJson(j("[1,2]"))), 400, "not an object");
  eq(await status(http.readJson(j(JSON.stringify({ a: "x".repeat(200_000) })))), 413, "too large");
  eq((await http.readJson(j('{"a":1}', "application/json; charset=utf-8"))).a, 1, "valid");
});

// ── CSRF ──────────────────────────────────────────────────────────────────

await test("state-changing requests must come from this site", () => {
  const r = (h) => new Request("http://app.test/api/x", { method: "POST", headers: { host: "app.test", ...h } });
  ok(http.sameOrigin(r({ origin: "http://app.test", "sec-fetch-site": "same-origin" })), "same origin");
  ok(http.sameOrigin(r({})), "no browser headers (curl, server-to-server)");
  ok(!http.sameOrigin(r({ "sec-fetch-site": "cross-site" })), "cross-site fetch metadata");
  ok(!http.sameOrigin(r({ "sec-fetch-site": "same-site" })), "sibling subdomain");
  ok(!http.sameOrigin(r({ origin: "https://evil.test" })), "foreign origin");
  ok(!http.sameOrigin(r({ origin: "null" })), "opaque origin (sandboxed frame, data: URL)");
  ok(http.sameOrigin(r({ origin: "https://app.example", "sec-fetch-site": "same-origin" })), "fetch metadata wins when a proxy rewrites Host");
});

// ── File types ────────────────────────────────────────────────────────────

await test("an upload's content must match its extension", () => {
  const b = (...parts) => new Uint8Array(parts.flatMap((p) => (typeof p === "string" ? [...Buffer.from(p, "latin1")] : p)));
  const zip = b("PK\x03\x04", "rest");
  const ole = b([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1], "rest");
  for (const ext of ["docx", "xlsx", "pptx", "odt", "ods", "odp"]) {
    ok(http.matchesType(zip, ext), `${ext} as zip`);
    ok(!http.matchesType(ole, ext), `${ext} as OLE`);
  }
  for (const ext of ["doc", "xls", "ppt"]) ok(http.matchesType(ole, ext), `${ext} as OLE`);
  ok(http.matchesType(b("{\\rtf1\\ansi hi}"), "rtf"), "rtf");
  ok(!http.matchesType(b("%PDF-1.7"), "docx"), "PDF named .docx");
  ok(http.matchesType(b("a,b\n1,2\n"), "csv"), "csv text");
  ok(!http.matchesType(b("a,b", [0], "\n"), "csv"), "binary named .csv");
  ok(http.matchesType(b("<!doctype html><p>hi"), "html"), "html text");
  ok(!http.matchesType(zip, "html"), "zip named .html");
  ok(!http.matchesType(zip, "exe"), "unknown extension");
});

// ── Errors ────────────────────────────────────────────────────────────────

await test("errors returned to clients say nothing about the server", async () => {
  const leaks = [
    new Error("Command failed: /usr/bin/soffice -env:UserInstallation=file:///tmp/office-x1/profile --headless /tmp/office-x1/input.docx"),
    Object.assign(new Error("ENOENT: no such file or directory, open '/tmp/office-x1/input.pdf'"), { code: "ENOENT" }),
    new Error("browserType.launch: Failed to launch chromium because executable doesn't exist at /Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
    new Error("SQLITE_ERROR: no such table: users"),
  ];
  const log = console.error;
  console.error = () => {}; // failure() logs the real error on the server
  for (const e of leaks) {
    const res = http.failure(e, "Couldn't convert that file.");
    eq(res.status, 500, "status");
    const { error } = await res.json();
    eq(error, "Couldn't convert that file.", `message for ${e.message.slice(0, 40)}`);
  }
  console.error = log;
  const known = http.failure(new http.HttpError(422, "Save it as .docx."), "fallback");
  eq(known.status, 422, "a deliberate error keeps its status");
  eq((await known.json()).error, "Save it as .docx.", "and its message");
});

// ── Subprocesses ──────────────────────────────────────────────────────────

if (process.platform !== "win32") {
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

  await test("a subprocess that runs too long is killed with all its children", async () => {
    const started = Date.now();
    let grandchild = 0;
    const err = await run.runProcess("sh", ["-c", "sleep 30 & echo $!; wait"], {
      timeoutMs: 400, maxOutputBytes: 1024,
      onStdout: (s) => (grandchild ||= Number(String(s).trim())),
    }).then(() => null, (e) => e);
    ok(err instanceof run.ProcessFailed, "rejects with ProcessFailed");
    eq(err.reason, "timeout", "reason");
    ok(Date.now() - started < 5000, "returns promptly");
    await new Promise((r) => setTimeout(r, 200));
    ok(grandchild > 0 && !alive(grandchild), `grandchild ${grandchild} was killed`);
  });

  await test("a subprocess that floods its output is stopped", async () => {
    const err = await run.runProcess("sh", ["-c", "yes nopload"], { timeoutMs: 10_000, maxOutputBytes: 64 * 1024 }).then(() => null, (e) => e);
    ok(err instanceof run.ProcessFailed, "rejects");
    eq(err.reason, "output", "reason");
  });

  if (process.platform === "linux" && existsSync("/usr/bin/prlimit"))
    await test("a subprocess over its memory cap fails", async () => {
      const grow = ["-c", "x=$(head -c 300000000 /dev/zero | tr '\\0' a); echo ${#x}"];
      const err = await run.runProcess("sh", grow, { timeoutMs: 20_000, maxOutputBytes: 1024, memoryMb: 100 }).then(() => null, (e) => e);
      ok(err instanceof run.ProcessFailed && err.reason === "exit", `capped: ${err?.reason}`);
    });

  await test("a subprocess gets a clean environment", async () => {
    process.env.AUTH_SECRET_TEST_LEAK = "s3cret";
    const { stdout } = await run.runProcess("sh", ["-c", "env"], { timeoutMs: 5000, maxOutputBytes: 1 << 20 });
    delete process.env.AUTH_SECRET_TEST_LEAK;
    ok(!stdout.includes("s3cret"), "server secrets aren't inherited");
  });

  await test("a subprocess that succeeds returns its output", async () => {
    const { stdout } = await run.runProcess("sh", ["-c", "echo done"], { timeoutMs: 5000, maxOutputBytes: 1024 });
    eq(stdout.trim(), "done", "stdout");
    ok(spawnSync("sh", ["-c", "true"]).status === 0, "shell available");
  });
}

await test("only a few conversions run at once, and the queue is bounded", async () => {
  const gate = run.limiter(1, 1);
  let release;
  const first = gate(() => new Promise((r) => (release = r)));
  const second = gate(async () => "second");
  const third = await gate(async () => "third").then(() => null, (e) => e);
  ok(third instanceof http.HttpError && third.status === 503, "third is refused as busy");
  release("first");
  eq(await first, "first", "first finishes");
  eq(await second, "second", "queued one runs after");
});

await test("a job past its deadline is abandoned", async () => {
  let cleaned = false;
  const err = await run.withDeadline(new Promise(() => {}), 50, () => (cleaned = true)).then(() => null, (e) => e);
  ok(err instanceof http.HttpError && err.status === 504, "504");
  ok(cleaned, "cleanup ran");
});

console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
