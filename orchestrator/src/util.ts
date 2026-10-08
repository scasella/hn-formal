import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

export function log(msg: string): void {
  const ts = new Date().toISOString().slice(11, 19);
  process.stderr.write(`[${ts}] ${msg}\n`);
}

export function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

/** YYYYMMDD-HHMMSS in UTC. */
export function stamp(d = new Date()): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return (
    `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-` +
    `${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`
  );
}

export function monthKey(d = new Date()): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export async function ensureDir(p: string): Promise<void> {
  await fsp.mkdir(p, { recursive: true });
}

export async function readJson<T>(p: string): Promise<T> {
  return JSON.parse(await fsp.readFile(p, "utf8")) as T;
}

export async function readJsonOr<T>(p: string, fallback: T): Promise<T> {
  try {
    return await readJson<T>(p);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw e;
  }
}

/** Write via temp file + rename so readers never see a partial file. */
export async function writeJsonAtomic(p: string, value: unknown): Promise<void> {
  await ensureDir(path.dirname(p));
  const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(value, null, 2) + "\n");
  await fsp.rename(tmp, p);
}

export async function writeFileAtomic(p: string, data: string | Buffer): Promise<void> {
  await ensureDir(path.dirname(p));
  const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tmp, data);
  await fsp.rename(tmp, p);
}

export function exists(p: string): boolean {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

/** Keep the tail of a long string (lake errors are at the end). */
export function tail(s: string, max = 12_000): string {
  if (s.length <= max) return s;
  return `...[${s.length - max} chars truncated]...\n` + s.slice(s.length - max);
}

export function envInt(name: string, def: number): number {
  const v = process.env[name];
  if (v === undefined || v === "") return def;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number, got ${JSON.stringify(v)}`);
  return n;
}

export function envStr(name: string, def: string): string {
  const v = process.env[name];
  return v === undefined || v === "" ? def : v;
}

export interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

/** Run a shell command (via `sh -c`) with captured output and a timeout. */
export function runShell(
  cmd: string,
  opts: { cwd: string; timeoutMs?: number; env?: NodeJS.ProcessEnv },
): Promise<RunResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn("sh", ["-c", cmd], {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, opts.timeoutMs)
      : null;
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      resolve({ code: -1, signal: null, stdout, stderr: stderr + String(err), timedOut, durationMs: Date.now() - started });
    });
    child.on("close", (code, signal) => {
      if (timer) clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, timedOut, durationMs: Date.now() - started });
    });
  });
}

export async function copyDir(src: string, dst: string, exclude: string[] = []): Promise<void> {
  await ensureDir(dst);
  await fsp.cp(src, dst, {
    recursive: true,
    filter: (s) => {
      const rel = path.relative(src, s);
      if (rel === "") return true;
      const first = rel.split(path.sep)[0]!;
      return !exclude.includes(first);
    },
  });
}

export function sha1Short(s: string): string {
  // Tiny non-crypto hash for IDs when git is unavailable.
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16).padStart(7, "0").slice(0, 7);
}

export async function gitShortSha(cwd: string): Promise<string | null> {
  const r = await runShell("git rev-parse --short=7 HEAD", { cwd, timeoutMs: 10_000 });
  return r.code === 0 ? r.stdout.trim() : null;
}

/** Like `git diff --shortstat` between two files; falls back to a line-count diff. */
export async function diffStat(oldFile: string, newFile: string, cwd: string): Promise<string> {
  const r = await runShell(
    `git diff --no-index --numstat -- ${JSON.stringify(oldFile)} ${JSON.stringify(newFile)}`,
    { cwd, timeoutMs: 10_000 },
  );
  const m = r.stdout.trim().match(/^(\d+)\t(\d+)\t/);
  if (m) return `+${m[1]} -${m[2]}`;
  if (r.code === 0) return "+0 -0";
  const a = exists(oldFile) ? fs.readFileSync(oldFile, "utf8").split("\n").length : 0;
  const b = exists(newFile) ? fs.readFileSync(newFile, "utf8").split("\n").length : 0;
  return b >= a ? `+${b - a} -0` : `+0 -${a - b}`;
}

export async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

/** Simple concurrency limiter. */
export function limiter(n: number) {
  let active = 0;
  const queue: Array<() => void> = [];
  const next = () => {
    if (active >= n) return;
    const job = queue.shift();
    if (job) {
      active++;
      job();
    }
  };
  return <T>(fn: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      queue.push(() => {
        fn()
          .then(resolve, reject)
          .finally(() => {
            active--;
            next();
          });
      });
      next();
    });
}
