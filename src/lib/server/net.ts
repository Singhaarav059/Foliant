import "server-only";
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";

// Which addresses a submitted URL may reach: public unicast only, so a page
// can't make the server talk to its own network or cloud metadata.

export type Lookup = (hostname: string) => Promise<{ address: string; family: number }[]>;
const defaultLookup: Lookup = (h) => dnsLookup(h, { all: true, verbatim: true });

// Private, shared, loopback, link-local, documentation, benchmarking,
// 6to4 relay, multicast and reserved ranges.
const V4_BLOCKED = ([
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16],
  ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const).map(([net, bits]) => [v4Int(net), bits] as const);

function v4Int(ip: string) {
  return ip.split(".").reduce((n, part) => n * 256 + Number(part), 0);
}

function blockedV4(ip: string) {
  const n = v4Int(ip);
  return V4_BLOCKED.some(([net, bits]) => Math.floor(n / 2 ** (32 - bits)) === Math.floor(net / 2 ** (32 - bits)));
}

// The 16 bytes of an IPv6 address, including the ::a.b.c.d forms.
export function v6Bytes(ip: string): number[] | null {
  const s = ip.replace(/%.*$/, "");
  if (isIP(s) !== 6) return null;
  let text = s;
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (v4) {
    const [a, b, c, d] = v4[1].split(".").map(Number);
    text = text.slice(0, -v4[1].length) + `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail] = text.split("::");
  const parts = (x: string | undefined) => (x ? x.split(":") : []);
  const groups = tail === undefined ? parts(head) : [...parts(head), ...Array(8 - parts(head).length - parts(tail).length).fill("0"), ...parts(tail)];
  return groups.flatMap((g) => {
    const n = parseInt(g, 16);
    return [n >> 8, n & 255];
  });
}

export function blockedIp(input: string) {
  const ip = input.replace(/^\[|\]$/g, "");
  if (isIP(ip) === 4) return blockedV4(ip);
  const b = v6Bytes(ip);
  if (!b) return true;
  // ::ffff:a.b.c.d is IPv4.
  if (b.slice(0, 10).every((x) => x === 0) && b[10] === 255 && b[11] === 255) return blockedV4(b.slice(12).join("."));
  // Global unicast is 2000::/3; everything else (::, ::1, ::a.b.c.d, NAT64
  // 64:ff9b::/96, discard 100::/64, fc00::/7, fe80::/10, ff00::/8) is not.
  if ((b[0] & 0xe0) !== 0x20) return true;
  const w0 = (b[0] << 8) | b[1], w1 = (b[2] << 8) | b[3];
  if (w0 === 0x2001 && w1 < 0x200) return true; // 2001::/23: Teredo, benchmarking, ORCHID
  if (w0 === 0x2001 && w1 === 0xdb8) return true; // documentation
  if (w0 === 0x2002) return true; // 6to4 carries any IPv4 address
  if (w0 === 0x3fff && w1 < 0x1000) return true; // documentation (3fff::/20)
  return false;
}

const LOCAL_NAME = /(^|\.)(localhost|local|internal|intranet|lan|localdomain|home\.arpa)$/i;

// The address to dial for a host, or null if the host isn't public. A name
// counts only when every address it resolves to is public; the caller must
// connect to the returned address, not resolve the name again.
export async function resolvePublic(hostname: string, lookup: Lookup = defaultLookup, allow = (ip: string) => !blockedIp(ip)) {
  const host = hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  if (!host || LOCAL_NAME.test(host)) return null;
  if (isIP(host)) return allow(host) ? host : null;
  try {
    const addrs = await lookup(host);
    return addrs.length > 0 && addrs.every((a) => allow(a.address)) ? addrs[0].address : null;
  } catch {
    return null;
  }
}

export const publicHost = async (hostname: string) => (await resolvePublic(hostname)) !== null;

// What Chrome may load at all; http(s) also goes through the egress proxy.
export const allowedScheme = (url: URL) => ["http:", "https:", "data:", "blob:"].includes(url.protocol);
