// The free hosted build (FOLIANT_STATIC=1, see next.config.ts): plain files,
// no server. Every tool runs in the browser; accounts and the contact form
// are left out.
export const STATIC = process.env.NEXT_PUBLIC_STATIC === "1";

// Where the static build sends feedback, if set.
export const REPO_URL = process.env.NEXT_PUBLIC_REPO_URL ?? "";
