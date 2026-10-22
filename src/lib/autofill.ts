"use client";

// Form autofill (P3-07): the details forms keep asking for (name, date of
// birth, address, PIN code…), kept on this device only, encrypted with a key
// made from the user's passphrase, and matched to a PDF form's fields by
// their names and tooltips. Nothing is synced or sent; clearing the site's
// data deletes it.

export const PROFILE_KEYS = [
  "fullName", "firstName", "middleName", "lastName", "fatherName", "motherName", "dob", "gender",
  "email", "phone", "address", "city", "district", "state", "pincode", "country", "nationality",
] as const;
export type ProfileKey = (typeof PROFILE_KEYS)[number];
export type Profile = Partial<Record<ProfileKey, string>>;

// What forms call each detail, normalised (see words()). Longer phrases win
// over shorter ones they contain ("father name" over "name").
const SYNONYMS: Record<ProfileKey, string[]> = {
  fullName: ["name", "full name", "applicant name", "applicants name", "candidate name", "candidates name", "name of applicant", "name of the applicant", "name of candidate", "name of the candidate", "student name", "your name", "customer name", "holder name", "account holder name"],
  firstName: ["first name", "given name", "forename", "fname"],
  middleName: ["middle name", "mname"],
  lastName: ["last name", "surname", "family name", "lname"],
  fatherName: ["father name", "fathers name", "name of father", "father s name", "guardian name", "fathers guardian name"],
  motherName: ["mother name", "mothers name", "name of mother", "mother s name"],
  dob: ["dob", "date of birth", "birth date", "birthdate", "d o b", "born on"],
  gender: ["gender", "sex"],
  email: ["email", "e mail", "email id", "email address", "mail id"],
  phone: ["phone", "mobile", "mobile no", "mobile number", "phone number", "contact number", "telephone", "tel", "contact no", "cell"],
  address: ["address", "postal address", "residential address", "permanent address", "correspondence address", "street", "address line 1", "street address"],
  city: ["city", "town", "village", "city town village"],
  district: ["district"],
  state: ["state", "province", "region", "state ut"],
  pincode: ["pin", "pin code", "pincode", "postal code", "post code", "postcode", "zip", "zip code", "zipcode"],
  country: ["country"],
  nationality: ["nationality", "citizenship"],
};

// Lower case, punctuation as spaces, one space between words: "D.O.B." → "d o b".
export const words = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
const compact = (s: string) => s.replace(/ /g, "");

// The profile detail a field asks for, from its name and tooltip, or null.
// A field named exactly like a synonym (ignoring punctuation and spaces) is
// the surest match; otherwise the longest synonym found as whole words.
export function matchField(field: { name: string; tooltip?: string }): ProfileKey | null {
  let best: { key: ProfileKey; score: number } | null = null;
  for (const text of [field.tooltip, field.name]) {
    if (!text) continue;
    // A field name's last part is its own: "applicant.dob" → "dob".
    const parts = [words(text), words(text.split(/[.\[\]]/).filter(Boolean).at(-1) ?? "")];
    for (const w of parts) {
      if (!w) continue;
      for (const key of PROFILE_KEYS) {
        for (const syn of SYNONYMS[key]) {
          const score = compact(w) === compact(syn) ? 100 + syn.length : ` ${w} `.includes(` ${syn} `) ? syn.length : 0;
          if (score && (!best || score > best.score)) best = { key, score };
        }
      }
    }
  }
  return best?.key ?? null;
}

// A field's value from the profile: dates in the field's format, a choice
// field's option that starts like the profile's value.
export function valueFor(key: ProfileKey, profile: Profile, field: { type: string; options?: string[]; dateFormat?: string }): string | null {
  let v = profile[key]?.trim();
  if (!v && key === "fullName") v = [profile.firstName, profile.middleName, profile.lastName].filter(Boolean).join(" ");
  if (!v) return null;
  if (key === "dob") v = formatDate(v, field.dateFormat ?? "DD/MM/YYYY") ?? v;
  if (field.options?.length) {
    const want = words(v);
    return field.options.find((o) => words(o) === want) ?? field.options.find((o) => words(o).startsWith(want) || want.startsWith(words(o))) ?? null;
  }
  return field.type === "checkbox" || field.type === "signature" ? null : v;
}

// "2001-08-15" in a form's format: DD/MM/YYYY, MM/DD/YYYY, YYYY-MM-DD, and
// the same with other separators or a two-digit year.
export function formatDate(iso: string, format: string): string | null {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const [, y, mo, d] = m;
  return format.replace(/YYYY|yyyy/, y).replace(/YY|yy/, y.slice(2)).replace(/MM|mm/, mo).replace(/DD|dd/, d);
}

// ── Encrypted storage. AES-GCM with a 256-bit key from PBKDF2-SHA-256
// (600,000 rounds, OWASP's figure), a random salt per profile and a random
// IV per save.
type Sealed = { v: 1; salt: Uint8Array; iv: Uint8Array; data: Uint8Array };
const ROUNDS = 600_000;

async function keyFrom(passphrase: string, salt: Uint8Array) {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", salt: salt as BufferSource, iterations: ROUNDS, hash: "SHA-256" }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

export async function seal(profile: Profile, passphrase: string): Promise<Sealed> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await keyFrom(passphrase, salt), new TextEncoder().encode(JSON.stringify(profile))));
  return { v: 1, salt, iv, data };
}

export class WrongPassphrase extends Error {}

export async function unseal(sealed: Sealed, passphrase: string): Promise<Profile> {
  try {
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: sealed.iv as BufferSource }, await keyFrom(passphrase, sealed.salt), sealed.data as BufferSource);
    return JSON.parse(new TextDecoder().decode(plain)) as Profile;
  } catch {
    throw new WrongPassphrase();
  }
}

const DB = "nopload-profile", STORE = "profile", KEY = "v1";
function db(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DB, 1);
    open.onupgradeneeded = () => open.result.createObjectStore(STORE);
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
}
async function tx<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const d = await db();
  try {
    return await new Promise<T>((resolve, reject) => {
      const req = run(d.transaction(STORE, mode).objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } finally {
    d.close();
  }
}

export const hasProfile = async () => !!(await tx("readonly", (s) => s.get(KEY)).catch(() => undefined));
export const saveProfile = async (profile: Profile, passphrase: string) => {
  const sealed = await seal(profile, passphrase);
  await tx("readwrite", (s) => s.put(sealed, KEY));
};
export const loadProfile = async (passphrase: string) => unseal((await tx("readonly", (s) => s.get(KEY))) as Sealed, passphrase);
export const deleteProfile = () => tx("readwrite", (s) => s.delete(KEY));
