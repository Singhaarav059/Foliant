// A workflow as a link: its name and steps, JSON in base64url, after
// #recipe= in the address. Browsers never send the part after # to a server,
// so a recipe travels from one person to another without ever reaching ours.
// Files and passwords are never part of it.

import { TOOLS, type ToolId } from "./tools";
import { withoutSecrets } from "./pdf/password";

export type Step = { tool: ToolId; options: Record<string, unknown> };
export type Recipe = { name: string; steps: Step[] };

const KEY = "recipe=";
// A recipe longer than this isn't one this page made.
const MAX = 8000;
const CHAINABLE = new Set(TOOLS.filter((t) => t.chainable).map((t) => t.id));
// Option values a link can carry: plain text, numbers and switches.
const plain = (v: unknown) => typeof v === "string" || typeof v === "number" || typeof v === "boolean";

// What may be saved or shared of a workflow: chainable steps, and no secrets or files.
export function cleanSteps(steps: Step[]): Step[] {
  return steps.map((s) => ({ tool: s.tool, options: withoutSecrets(Object.fromEntries(Object.entries(s.options).filter(([, v]) => plain(v)))) }));
}

// Imported and linked workflows are untrusted: only steps that name a chainable tool.
export function isRecipe(w: unknown): w is Recipe {
  const x = w as { name?: unknown; steps?: unknown };
  return typeof x?.name === "string" && Array.isArray(x.steps) && x.steps.length > 0 &&
    x.steps.every((s: { tool?: unknown; options?: unknown }) =>
      CHAINABLE.has(s?.tool as ToolId) && typeof s.options === "object" && s.options !== null && !Array.isArray(s.options));
}

const toBase64Url = (bytes: Uint8Array) => {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const fromBase64Url = (s: string) => {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};

// The fragment for a recipe, "#recipe=…".
export function recipeHash(r: Recipe): string {
  const json = JSON.stringify({ v: 1, name: r.name.slice(0, 80), steps: cleanSteps(r.steps) });
  return `#${KEY}${toBase64Url(new TextEncoder().encode(json))}`;
}

// The recipe in a fragment ("#recipe=…"), null when there is none, "bad"
// when there is one this page can't use (damaged, or not a workflow).
export function readRecipe(hash: string): Recipe | null | "bad" {
  const at = hash.indexOf(KEY);
  if (at < 0) return null;
  const body = hash.slice(at + KEY.length).split("&")[0];
  if (!body || body.length > MAX) return "bad";
  try {
    const data = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(fromBase64Url(body)));
    if (data?.v !== 1 || !isRecipe(data)) return "bad";
    return { name: data.name.slice(0, 80), steps: cleanSteps(data.steps) };
  } catch {
    return "bad";
  }
}
