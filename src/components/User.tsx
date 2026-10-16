"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { STATIC } from "@/lib/mode";

export type User = { id: number; email: string; name: string };
type Ctx = { user: User | null; ready: boolean; refresh: () => Promise<void>; setUser: (u: User | null) => void };

const UserContext = createContext<Ctx>({ user: null, ready: false, refresh: async () => {}, setUser: () => {} });

// Pages stay static; the signed-in state is fetched once on the client.
// The static build has no accounts, so it is never signed in.
export function UserProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(STATIC);
  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/auth/me", { cache: "no-store" });
      setUser((await res.json()).user ?? null);
    } catch {
      setUser(null);
    } finally {
      setReady(true);
    }
  }, []);
  useEffect(() => {
    if (STATIC) return;
    let live = true;
    fetch("/api/auth/me", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => live && setUser(d.user ?? null))
      .catch(() => live && setUser(null))
      .finally(() => live && setReady(true));
    return () => {
      live = false;
    };
  }, []);
  return <UserContext.Provider value={{ user, ready, refresh, setUser }}>{children}</UserContext.Provider>;
}

export const useUser = () => useContext(UserContext);

export async function postJson<T = unknown>(url: string, body?: unknown, method = "POST"): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error ?? `Error ${res.status}`), { code: data.error, status: res.status });
  return data as T;
}
