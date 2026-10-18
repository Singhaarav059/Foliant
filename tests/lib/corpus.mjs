// Fixtures from the hostile-input corpus (tests/robustness/gen.mjs), made on
// the fly into a temporary folder that goes with the process.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { root } from "./load.mjs";

export function corpus(names) {
  const dir = mkdtempSync(join(tmpdir(), "corpus-"));
  process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
  const only = `^(${names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})$`;
  execFileSync(process.execPath, [join(root, "tests/robustness/gen.mjs"), dir, only], { cwd: root, stdio: ["ignore", "ignore", "inherit"] });
  return Object.fromEntries(names.map((n) => [n, new Uint8Array(readFileSync(join(dir, n)))]));
}
