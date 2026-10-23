import "server-only";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { HttpError } from "./errors";

export class ProcessFailed extends Error {
  constructor(public reason: "timeout" | "output" | "exit" | "spawn", public detail = "") {
    super(`Subprocess failed (${reason})`);
  }
}

// Only what a converter needs; the server's own settings and secrets stay out
// of the child's environment.
const PASS_ENV = ["PATH", "HOME", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "TMP", "TEMP", "SystemRoot", "windir", "FONTCONFIG_PATH", "FONTCONFIG_FILE"];
const cleanEnv = () =>
  Object.fromEntries(PASS_ENV.filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]!])) as NodeJS.ProcessEnv;

// MAX_SUBPROCESS_MB (or memoryMb per call) caps a converter's address space on Linux (via prlimit).
// Off by default: LibreOffice reserves much more than it uses, so set it from
// measurements on the host, or cap memory with the container instead.
const MEMORY_MB = Number(process.env.MAX_SUBPROCESS_MB ?? 0);
const PRLIMIT = process.platform === "linux" && existsSync("/usr/bin/prlimit") ? "/usr/bin/prlimit" : null;

type RunOptions = { timeoutMs: number; maxOutputBytes: number; memoryMb?: number; onStdout?: (chunk: Buffer) => void };

// Runs a converter in its own process group. On a timeout, too much output or
// when it exits, the whole group is killed, so helpers it started (soffice
// forks soffice.bin) don't outlive the request.
export function runProcess(bin: string, args: string[], o: RunOptions): Promise<{ stdout: string; stderr: string }> {
  const mb = o.memoryMb ?? MEMORY_MB;
  const [cmd, argv]: [string, string[]] = mb > 0 && PRLIMIT ? [PRLIMIT, [`--as=${mb * 1024 * 1024}`, "--", bin, ...args]] : [bin, args];
  return new Promise((resolve, reject) => {
    const group = process.platform !== "win32";
    const child = spawn(cmd, argv, { detached: group, stdio: ["ignore", "pipe", "pipe"], env: cleanEnv(), windowsHide: true });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let size = 0;
    let done = false;
    const kill = () => {
      try {
        if (group && child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    };
    const fail = (reason: ProcessFailed["reason"], detail = "") => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      kill();
      reject(new ProcessFailed(reason, detail));
    };
    const timer = setTimeout(() => fail("timeout"), o.timeoutMs);
    const take = (list: Buffer[], onChunk?: (c: Buffer) => void) => (c: Buffer) => {
      if (done) return;
      size += c.length;
      if (size > o.maxOutputBytes) return fail("output");
      list.push(c);
      onChunk?.(c);
    };
    child.stdout.on("data", take(out, o.onStdout));
    child.stderr.on("data", take(err));
    child.on("error", (e) => fail("spawn", e.message));
    child.on("close", (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      kill();
      const stdout = Buffer.concat(out).toString();
      const stderr = Buffer.concat(err).toString();
      if (code === 0) resolve({ stdout, stderr });
      else reject(new ProcessFailed("exit", stderr.slice(-2000)));
    });
  });
}

// At most `max` jobs at once and `queue` waiting; past that the server says
// it's busy instead of piling up browsers and LibreOffice processes.
export function limiter(max: number, queue: number) {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async function <T>(fn: () => Promise<T>): Promise<T> {
    if (active >= max) {
      if (waiting.length >= queue) throw new HttpError(503, "The server is busy. Try again in a minute.");
      await new Promise<void>((resolve) => waiting.push(resolve));
    } else active++;
    try {
      return await fn();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active--;
    }
  };
}

// Gives up on a job after `ms`, running `onTimeout` to free what it holds.
export function withDeadline<T>(job: Promise<T>, ms: number, onTimeout: () => unknown): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      Promise.resolve().then(onTimeout).catch(() => {});
      reject(new HttpError(504, "That took too long."));
    }, ms);
  });
  return Promise.race([job, deadline]).finally(() => clearTimeout(timer));
}
