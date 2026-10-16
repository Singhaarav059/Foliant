import "server-only";
import { cookies } from "next/headers";
import { SignJWT, jwtVerify } from "jose";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR, getDb, publicUser, type UserRow } from "./db";

const COOKIE = "session";
const MAX_AGE = 60 * 60 * 24 * 30;

// AUTH_SECRET in production; a generated one kept in ./data for local use.
function secret() {
  if (process.env.AUTH_SECRET) return new TextEncoder().encode(process.env.AUTH_SECRET);
  const file = join(DATA_DIR, "auth-secret");
  if (!existsSync(file)) {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(file, randomBytes(48).toString("hex"), { mode: 0o600 });
  }
  return new TextEncoder().encode(readFileSync(file, "utf8").trim());
}

export async function startSession(userId: number) {
  const token = await new SignJWT({})
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(String(userId))
    .setIssuedAt()
    .setExpirationTime(`${MAX_AGE}s`)
    .sign(secret());
  (await cookies()).set(COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: MAX_AGE,
  });
}

export async function endSession() {
  (await cookies()).delete(COOKIE);
}

export async function currentUser() {
  const token = (await cookies()).get(COOKIE)?.value;
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secret(), { algorithms: ["HS256"] });
    const row = getDb().prepare("SELECT * FROM users WHERE id = ?").get(Number(payload.sub)) as UserRow | undefined;
    return row ?? null;
  } catch {
    return null;
  }
}

export async function currentPublicUser() {
  const u = await currentUser();
  return u ? publicUser(u) : null;
}

export const json = (data: unknown, status = 200) => Response.json(data, { status });
export const error = (message: string, status = 400) => Response.json({ error: message }, { status });

// Same-origin check for state-changing JSON requests (cookies are SameSite=Lax too).
export function sameOrigin(req: Request) {
  const origin = req.headers.get("origin");
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.get("host");
  } catch {
    return false;
  }
}
