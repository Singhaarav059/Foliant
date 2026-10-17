import "server-only";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LICENSES } from "./vendor";

// The licences scripts/vendor.mjs collects for the licences page: texts in a
// folder named by their own hash (not the engines'), listed in licenses.json.
export const LICENSES_URL = LICENSES;

type Package = { name: string; version: string; license: string; source: string };
export type Licenses = {
  components: { name: string; file: string; packages: Package[]; includes: { name: string; license: string; source: string }[] }[];
  libraries: Package[];
  librariesFile: string;
};

// Read while the page is built. Missing means scripts/vendor.mjs hasn't run
// since the licences were added: run it (npm install does).
export function readLicenses(): Licenses {
  return JSON.parse(readFileSync(join(process.cwd(), "public", LICENSES_URL, "licenses.json"), "utf8"));
}
