import "server-only";
import { cookies } from "next/headers";
import { SignJWT, jwtVerify } from "jose";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR, getDb, publicUser, type UserRow } from "./db";

export { error, json, sameOrigin } from "./http";

// Over HTTPS the cookie is __Host- prefixed: Secure, no Domain, Path=/, so a
// sibling subdomain can't plant a session in this site. Plain HTTP (local
// development) can't set Secure cookies, so it uses the bare name.
const SECURE = process.env.NODE_ENV === "production";
const COOKIE = SECURE ? "__Host-session" : "session";
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

// Every sign-in gets a new token (a random jti), never one the browser
// already had. `ver` ties it to the user's session_version.
export async function startSession(user: Pick<UserRow, "id" | "session_version">) {
  const token = await new SignJWT({ ver: user.session_version })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(String(user.id))
    .setJti(randomUUID())
    .setIssuedAt()
    .setExpirationTime(`${MAX_AGE}s`)
    .sign(secret());
  (await cookies()).set(COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: SECURE,
    path: "/",
    maxAge: MAX_AGE,
  });
}

async function currentSession() {
  const token = (await cookies()).get(COOKIE)?.value;
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secret(), { algorithms: ["HS256"] });
    const db = getDb();
    if (!payload.jti || db.prepare("SELECT 1 FROM revoked_sessions WHERE jti = ?").get(payload.jti)) return null;
    const user = db.prepare("SELECT * FROM users WHERE id = ?").get(Number(payload.sub)) as UserRow | undefined;
    if (!user || user.session_version !== payload.ver) return null;
    return { user, jti: payload.jti, exp: payload.exp ?? 0 };
  } catch {
    return null;
  }
}

// Signs this browser out, and revokes its token in case it was copied.
export async function endSession() {
  const session = await currentSession();
  if (session) {
    const db = getDb();
    db.prepare("INSERT OR IGNORE INTO revoked_sessions (jti, expires_at) VALUES (?, ?)").run(session.jti, session.exp);
    db.prepare("DELETE FROM revoked_sessions WHERE expires_at < ?").run(Math.floor(Date.now() / 1000));
  }
  (await cookies()).delete({ name: COOKIE, path: "/", secure: SECURE, httpOnly: true, sameSite: "lax" });
}

// Signs out every session of the user (after a password change), then signs
// this browser back in with a new token.
export async function restartSessions(user: UserRow) {
  getDb().prepare("UPDATE users SET session_version = session_version + 1 WHERE id = ?").run(user.id);
  await startSession({ id: user.id, session_version: user.session_version + 1 });
}

export async function currentUser() {
  return (await currentSession())?.user ?? null;
}

export async function currentPublicUser() {
  const u = await currentUser();
  return u ? publicUser(u) : null;
}
