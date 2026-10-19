import "server-only";
import { createServer, request, type IncomingHttpHeaders } from "node:http";
import { connect, type Socket } from "node:net";
import { resolvePublic, blockedIp, type Lookup } from "./net";

// The only way Chrome reaches the network. Chrome sends every http and https
// request here with the host name unresolved; the proxy resolves it once,
// refuses anything that isn't public, and connects to the address it checked.
// A name that answers with a public address for the check and a private one
// for the connection (DNS rebinding) can't switch it, and redirects are
// checked again because Chrome sends each hop through here.

export type EgressOptions = { lookup?: Lookup; allow?: (ip: string) => boolean };

// Header on the proxy's own refusals, so a blocked page isn't printed as a result.
export const BLOCKED_HEADER = "x-nopload-egress";

const webPort = (port: number) => port === 80 || port === 443 || (port >= 1024 && port <= 65535);
const IDLE_MS = 60_000;

const HOP_BY_HOP = new Set(["proxy-connection", "proxy-authorization", "connection", "keep-alive", "te", "trailer", "upgrade"]);

export async function startEgressProxy(o: EgressOptions = {}) {
  const allow = o.allow ?? ((ip: string) => !blockedIp(ip));
  const target = async (host: string, port: number) => (webPort(port) ? resolvePublic(host, o.lookup, allow) : null);
  const sockets = new Set<Socket>();

  const server = createServer(async (req, res) => {
    const refuse = (status: number) => {
      res.writeHead(status, { [BLOCKED_HEADER]: "blocked", "Content-Type": "text/plain", Connection: "close" });
      res.end("Blocked by the server's egress rules.");
    };
    let url: URL;
    try {
      url = new URL(req.url ?? "");
    } catch {
      return refuse(400);
    }
    if (url.protocol !== "http:") return refuse(400);
    const port = Number(url.port || 80);
    const ip = await target(url.hostname, port);
    if (!ip) return refuse(403);
    const headers: IncomingHttpHeaders = Object.fromEntries(Object.entries(req.headers).filter(([k]) => !HOP_BY_HOP.has(k)));
    headers.host = url.host;
    const up = request({ host: ip, port, method: req.method, path: url.pathname + url.search, headers, setHost: false, agent: false, timeout: IDLE_MS }, (upRes) => {
      res.writeHead(upRes.statusCode ?? 502, upRes.headers);
      upRes.pipe(res);
    });
    up.on("timeout", () => up.destroy());
    up.on("error", () => (res.headersSent ? res.destroy() : refuse(502)));
    req.pipe(up);
  });

  server.on("connect", async (req, client: Socket, head: Buffer) => {
    sockets.add(client);
    client.on("close", () => sockets.delete(client));
    client.on("error", () => client.destroy());
    const deny = () => client.end(`HTTP/1.1 403 Forbidden\r\n${BLOCKED_HEADER}: blocked\r\nConnection: close\r\n\r\n`);
    let url: URL;
    try {
      url = new URL(`http://${req.url}`);
    } catch {
      return deny();
    }
    const port = Number(url.port || 80);
    if (!url.port && !/:80$/.test(req.url ?? "")) return deny();
    const ip = await target(url.hostname, port);
    if (!ip) return deny();
    const up = connect(port, ip, () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) up.write(head);
      up.pipe(client);
      client.pipe(up);
    });
    sockets.add(up);
    up.setTimeout(IDLE_MS, () => up.destroy());
    client.setTimeout(IDLE_MS, () => client.destroy());
    up.on("close", () => {
      sockets.delete(up);
      client.destroy();
    });
    up.on("error", () => client.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n"));
    client.on("close", () => up.destroy());
  });
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return {
    port: typeof address === "object" && address ? address.port : 0,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}
